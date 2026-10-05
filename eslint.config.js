import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Browser globals that must only be touched in the platform adapter, so every other module takes
// its dependencies by injection and stays testable against the hand-written mock in test/harness.
const platformOnlyGlobals = ['chrome', 'browser'].map((name) => ({
  name,
  message: 'Use the injected ExtApi (src/lib/platform.ts) instead of the extension global.',
}));

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/lib/protocol.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-globals': ['error', ...platformOnlyGlobals],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Build DOM with textContent and createElement.' },
        { property: 'outerHTML', message: 'Build DOM with textContent and createElement.' },
        {
          property: 'insertAdjacentHTML',
          message: 'Build DOM with textContent and createElement.',
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/lib/platform.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // Plain JavaScript tooling is type-checked by tsc (checkJs); the typed lint rules add little.
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
