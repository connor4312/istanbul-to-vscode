import { promises as fs } from 'fs';
import {
  FileCoverageData,
  Location as IstanbulLocation,
  Range as IstanbulRange,
} from 'istanbul-lib-coverage';
import { join } from 'path';
import * as vscode from 'vscode';

export interface IIstanbulCoverageOptions {
  /**
   * Whether coverage data should be removed when the run is disposed.
   * Defaults to true.
   */
  removeCoverageDataAtEndOfRun?: boolean;

  /**
   * If set to true, the executions are set as boolean (covered or not covered)
   * instead of counts. Tools that don't support fine-grained counts should
   * set this to true.
   */
  booleanCounts?: boolean;

  /**
   * Called to transform a URI seen in the coverage report. You can for example
   * apply sourcemap transformations here.
   */
  mapFileUri?(uri: vscode.Uri): Promise<vscode.Uri | undefined>;

  /**
   * Called to transform a location seen in the coverage report. You can for
   * example apply sourcemap transformations here.
   */
  mapLocation?(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | undefined>;
}

const FINAL_COVERAGE_FILE_NAME = 'coverage-final.json';

export class IstanbulMissingCoverageError extends Error {
  constructor(dir: string, err: Error) {
    super(
      `Could not read ${FINAL_COVERAGE_FILE_NAME} in ${dir}. Make sure the test was run with "json" coverage enabled: ${err}`,
    );
  }
}

/**
 * Handles mapping
 */
export class IstanbulCoverageContext {
  private readonly defaultOptions: IIstanbulCoverageOptions = {
    removeCoverageDataAtEndOfRun: true,
    booleanCounts: false,
  };

  constructor(defaultOptions?: Partial<IIstanbulCoverageOptions>) {
    Object.assign(this.defaultOptions, defaultOptions);
  }

  /**
   * Applies coverage written out to the given directory to the test run.
   * It expects Istanbul to have generated a "json" coverage format with the
   * directory containing a `coverage-final.json` file.
   * @throws IstanbulMissingCoverageError if the coverage file could not be read.
   */
  public async apply(
    run: vscode.TestRun,
    coverageDir: string,
    opts?: Partial<IIstanbulCoverageOptions>,
  ) {
    let coverage: Record<string, FileCoverageData>;
    try {
      coverage = JSON.parse(
        await fs.readFile(join(coverageDir, FINAL_COVERAGE_FILE_NAME), 'utf-8'),
      );
    } catch (e) {
      throw new IstanbulMissingCoverageError(coverageDir, e as Error);
    }

    const options = { ...this.defaultOptions, ...opts };
    if (options.removeCoverageDataAtEndOfRun) {
      const l = run.onDidDispose(() => {
        l.dispose();
        fs.rm(coverageDir, { recursive: true }).catch(() => {
          /* ignored */
        });
      });
    }

    return this.applyJson(run, coverage, options);
  }

  /**
   * Applies coverage from the Istanbul file format to the run.
   */
  public async applyJson(
    run: vscode.TestRun,
    files: Record<string, FileCoverageData>,
    opts?: Partial<IIstanbulCoverageOptions>,
  ) {
    const options = { ...this.defaultOptions, ...opts };

    await Promise.all(
      Object.values(files).map(async (entry: FileCoverageData) => {
        const compiledUri = vscode.Uri.file(entry.path);
        const originalUri = (await options.mapFileUri?.(compiledUri)) || compiledUri;
        run.addCoverage(
          new IstanbulFileCoverage(originalUri || compiledUri, entry, compiledUri, options),
        );
      }),
    );
  }

  /**
   * Assignable to vscode.TestRunProfile.loadDetailedCoverage
   */
  public readonly loadDetailedCoverage: vscode.TestRunProfile['loadDetailedCoverage'] = async (
    _testRun,
    file,
  ) => {
    if (!(file instanceof IstanbulFileCoverage)) {
      return [];
    }

    const opts = file.options;
    const details: vscode.FileCoverageDetail[] = [];
    const todo: Promise<void>[] = [];

    for (const [key, branch] of Object.entries(file.original.branchMap)) {
      todo.push(
        Promise.all([
          mapRange(opts, file.compiledUri, branch.loc),
          ...branch.locations.map((l) =>
            l.start.line !== undefined
              ? mapRange(opts, file.compiledUri, l)
              : // the implicit "else" case of 'if' statements are emitted as a
                // branch with no range; use a zero-length range of the conditional
                // end location to represent this.
                mapRange(opts, file.compiledUri, { start: branch.loc.end, end: branch.loc.end }),
          ),
        ]).then(([loc, ...branches]) => {
          if (!loc || branches.some((b) => !b)) {
            // no-op
          } else {
            let hits = 0;
            const branchCoverage: vscode.BranchCoverage[] = [];
            for (const [i, location] of branches.entries()) {
              const branchHit = file.original.b[key][i];
              hits += branchHit;
              branchCoverage.push(
                new vscode.BranchCoverage(
                  mapCount(opts, branchHit),
                  location!,
                  branch.type === 'if' ? (i === 0 ? 'if' : 'else') : undefined,
                ),
              );
            }
            details.push(new vscode.StatementCoverage(mapCount(opts, hits), loc, branchCoverage));
          }
        }),
      );
    }

    for (const [key, stmt] of Object.entries(file.original.statementMap)) {
      todo.push(
        mapRange(opts, file.compiledUri, stmt).then((loc) => {
          if (loc) {
            details.push(new vscode.StatementCoverage(mapCount(opts, file.original.s[key]), loc));
          }
        }),
      );
    }

    for (const [key, stmt] of Object.entries(file.original.fnMap)) {
      todo.push(
        mapRange(opts, file.compiledUri, stmt.loc).then((loc) => {
          if (loc) {
            details.push(
              new vscode.DeclarationCoverage(stmt.name, mapCount(opts, file.original.f[key]), loc),
            );
          }
        }),
      );
    }

    await Promise.all(todo);

    return details;
  };
}

const mapRange = async (opts: IIstanbulCoverageOptions, uri: vscode.Uri, range: IstanbulRange) => {
  const [start, end] = await Promise.all([
    mapLocation(opts, uri, range.start),
    mapLocation(opts, uri, range.end),
  ]);
  if (start && end) {
    return new vscode.Range(start.range.start, end.range.end);
  }
  const some = start || end;
  if (some) {
    return some.range;
  }

  return undefined;
};

const mapLocation = async (
  opts: IIstanbulCoverageOptions,
  uri: vscode.Uri,
  location: IstanbulLocation,
) => {
  const position = new vscode.Position(location.line - 1, location.column);
  // note: we intentionally don't await mapLocation here because we want to
  // propagate if it resolves to undefined.
  return opts.mapLocation?.(uri, position) || new vscode.Location(uri, position);
};

const mapCount = (opts: IIstanbulCoverageOptions, n: number) => (opts.booleanCounts ? n > 0 : n);

class IstanbulFileCoverage extends vscode.FileCoverage {
  constructor(
    uri: vscode.Uri,
    public readonly original: FileCoverageData,
    public readonly compiledUri: vscode.Uri,
    public readonly options: IIstanbulCoverageOptions,
  ) {
    super(uri, parseToSum(original.s), parseToSum(original.b), parseToSum(original.f));
  }
}

const parseToSum = (p: Record<string, number[] | number>): vscode.TestCoverageCount => {
  let covered = 0;
  let total = 0;
  for (const count of Object.values(p)) {
    if (count instanceof Array) {
      for (const c of count) {
        covered += c ? 1 : 0;
        total++;
      }
    } else {
      covered += count ? 1 : 0;
      total++;
    }
  }

  return new vscode.TestCoverageCount(covered, total);
};
