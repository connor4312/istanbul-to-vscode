# istanbul-to-vscode

A utility library that converts Istanbul coverage reports to the format expected by VS Code's test coverage API.

## Usage

In simple cases, you can just read the Istanbul report and create the coverage provider that we export:

```ts
import { IstanbulCoverageContext } from 'istanbul-to-vscode';

export const coverageContext = new IstanbulCoverageContext();

function activate() {
  // ...

  testRunProfile.loadDetailedCoverage = coverageContext.loadDetailedCoverage;
}

async function runTests() {
  // ...

  await coverageContext.apply(testRun, coverageDir);
}
```

But often you may want to apply sourcemap mappings. To do that, you can provide additional options either in `apply()` or when creating the `CoverageContext`:

```ts
async function runTests() {
  // ...

  await coverageContext.apply(task, coverageDir, {
    mapFileUri: (uri) => sourceMapStore.mapUri(uri),
    mapPosition: (uri, position) => sourceMapStore.mapLocation(uri, position),
  });
}
```
