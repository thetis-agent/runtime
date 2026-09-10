/** Defend the compiler's blind spots and package boundaries; ADR 0002. */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['docs/**', 'node_modules/**', '.runtime/**', '.registry/**', 'packages/gateway-web/assets/**'] },
  ...tseslint.configs.strictTypeChecked.map(config => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'max-lines': ['error', 400],
      'max-lines-per-function': ['error', 60]
    }
  },
  {
    files: ['packages/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [
      { regex: '^(?:@thetis/package-|#packages/|@/(?!(?:lib|contracts|test)/)|\\.\\./(?!\\.\\./(?:lib|contracts|test)/)|(?:\\.\\./){2}(?!(?:lib|contracts|test)/))', message: 'Import shared lib or contracts only.' }
    ] }] }
  }
);
