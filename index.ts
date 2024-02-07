import * as vscode from 'vscode';
import { FileCoverageData, Range as IstanbulRange } from 'istanbul-lib-coverage';

export class IstanbulCoverage implements vscode.TestCoverageProvider {
  /**
   * Creates a new instance of the IstanbulCoverage class.
   * @param files The file coverage data, which is the JSON contents of
   * Istanbul's "json" coverage output file.
   */
  constructor(protected readonly files: Record<string, FileCoverageData>) {}

  /**
   * Called to transform a URI seen in the coverage report. You can for example
   * apply sourcemap transformations here.
   */
  protected mapFileUri(compiledUri: vscode.Uri): Promise<vscode.Uri> {
    return Promise.resolve(compiledUri);
  }

  /**
   * Called to transform a location seen in the coverage report. You can for
   * example apply sourcemap transformations here.
   */
  protected mapLocation(
    compiledUri: vscode.Uri,
    base0Line: number,
    base0Column: number,
  ): Promise<vscode.Location | undefined> {
    return Promise.resolve(new vscode.Location(compiledUri, new vscode.Position(base0Line, base0Column)));
  }

  /** @inheritdoc */
  public provideFileCoverage(): Promise<IstanbulFileCoverage[]> {
    return Promise.all(
      Object.values(this.files).map(async (entry: FileCoverageData) => {
        const compiledUri = vscode.Uri.file(entry.path);
        const originalUri = await this.mapFileUri(compiledUri);
        return new IstanbulFileCoverage(originalUri || compiledUri, entry, compiledUri);
      }),
    );
  }

  /** @inheritdoc */
  public async resolveFileCoverage(file: IstanbulFileCoverage): Promise<IstanbulFileCoverage> {
    const details: vscode.DetailedCoverage[] = [];
    const todo: Promise<void>[] = [];

    for (const [key, branch] of Object.entries(file.original.branchMap)) {
      todo.push(
        Promise.all([
          this.mapRange(file.compiledUri, branch.loc),
          ...branch.locations.map((l) =>
            l.start.line !== undefined
              ? this.mapRange(file.compiledUri, l)
              : // the implicit "else" case of 'if' statements are emitted as a
                // branch with no range; use a zero-length range of the conditional
                // end location to represent this.
                this.mapRange(file.compiledUri, { start: branch.loc.end, end: branch.loc.end }),
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
                  !!branchHit,
                  location!,
                  branch.type === 'if' ? (i === 0 ? 'if' : 'else') : undefined,
                ),
              );
            }
            details.push(new vscode.StatementCoverage(!!hits, loc, branchCoverage));
          }
        }),
      );
    }

    for (const [key, stmt] of Object.entries(file.original.statementMap)) {
      todo.push(
        this.mapRange(file.compiledUri, stmt).then((loc) => {
          if (loc) {
            details.push(new vscode.StatementCoverage(!!file.original.s[key], loc));
          }
        }),
      );
    }

    for (const [key, stmt] of Object.entries(file.original.fnMap)) {
      todo.push(
        this.mapRange(file.compiledUri, stmt.loc).then((loc) => {
          if (loc) {
            details.push(new vscode.FunctionCoverage(stmt.name, !!file.original.f[key], loc));
          }
        }),
      );
    }

    await Promise.all(todo);

    file.detailedCoverage = details;
    return file;
  }

  private async mapRange(uri: vscode.Uri, range: IstanbulRange) {
    const [start, end] = await Promise.all([
      this.mapLocation(uri, range.start.line, range.start.column),
      this.mapLocation(uri, range.end.line, range.end.column),
    ]);
    if (start && end) {
      return new vscode.Range(start.range.start, end.range.end);
    }
    const some = start || end;
    if (some) {
      return some.range;
    }

    return undefined;
  }
}

export class IstanbulFileCoverage extends vscode.FileCoverage {
  constructor(
    uri: vscode.Uri,
    public readonly original: FileCoverageData,
    public readonly compiledUri: vscode.Uri,
  ) {
    super(uri, parseToSum(original.s), parseToSum(original.b), parseToSum(original.f));
  }
}

const parseToSum = (p: Record<string, number[] | number>): vscode.CoveredCount => {
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

  return new vscode.CoveredCount(covered, total);
};
