/** ts-jest + node 环境。inline tsconfig（commonjs/esModuleInterop/ES2020）避开主/渲染 tsconfig 的
 *  noEmit/bundler 设置，仅用于测试编译。测试文件不进 dist（tsconfig.main.json 已 exclude __tests__）。 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2020',
          esModuleInterop: true,
          allowJs: false,
          strict: true,
          skipLibCheck: true,
          isolatedModules: false,
          resolveJsonModule: true,
        },
      },
    ],
  },
};
