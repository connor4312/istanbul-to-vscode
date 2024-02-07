# istanbul-to-vscode

A utility library that converts Istanbul coverage reports to the format expected by VS Code's test coverage API.

## Usage

In simple cases, you can just read the Istanbul report and create the coverage provider that we export:

```ts
import { IstanbulCoverage } from 'istanbul-to-vscode';

function runTests() {
  // ...

  const coverage = JSON.parse(fs.readFileSync(`${dir}/coverage-final.json`));
  testRun.coverageProvider = new IstanbulCoverage(coverage);
}
```

But often you may want to apply sourcemap mappings. To do that, you can subclass the class we provide:

```ts
import { IstanbulCoverage } from 'istanbul-to-vscode';

class MyCoverageProvider extends IstanbulCoverage {
  // map file paths:
  protected override async mapFileUri(compiledUri: vscode.Uri): Promise<vscode.Uri> {
    return vscode.Uri.file(await lookupSourceMapFile(compiledUri.fsPath));
  }

  // map locations within files:
  protected override async mapLocation(
    compiledUri: vscode.Uri,
    base0Line: number,
    base0Column: number,
  ): Promise<vscode.Location> {
    const mapped = await lookupSourceMapPosition(compiledUri.fsPath, base0Line, base0Column + 1);
    if (!mapped) return vscode.Location(compiledUri, base0Line, base0Column + 1);
    return new vscode.Location(vscode.Uri.file(mapped.file), mapped.line, mapped.column);
  }
}

function runTests() {
  // ...

  const coverage = JSON.parse(fs.readFileSync(`${dir}/coverage-final.json`));
  testRun.coverageProvider = new MyCoverageProvider(coverage);
}
```
