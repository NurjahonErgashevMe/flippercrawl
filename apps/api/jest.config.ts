import { createDefaultEsmPreset, type JestConfigWithTsJest } from "ts-jest";

const config: JestConfigWithTsJest = {
  ...createDefaultEsmPreset({
    // NodeNext без isolatedModules в tsconfig — ts-jest спамит TS151002
    diagnostics: { ignoreCodes: [151002] },
  }),
  verbose: true,
  testPathIgnorePatterns: ["<rootDir>/dist/"],
  forceExit: true,
  detectOpenHandles: true,
  openHandlesTimeout: 120000,
  watchAll: false,
  reporters: [
    "default",
    [
      "jest-junit",
      {
        outputDirectory: "<rootDir>/test-results",
        outputName: "junit.xml",
        addFileAttribute: true,
        suiteNameTemplate: "{filepath}",
      },
    ],
  ],
};

export default config;
