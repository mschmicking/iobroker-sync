import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Lint rules for iobroker-sync.
 *
 * The type-checked ruleset is used deliberately: this tool is full of async I/O
 * against a live home-automation system, and the rules that actually matter here
 * (floating promises, misused promises) cannot be detected without type information.
 *
 * Formatting is Prettier's job — `eslint-config-prettier` last switches off every
 * stylistic rule so the two never argue.
 */
export default tseslint.config(
  {
    ignores: ['dist/', 'dist-test/', 'node_modules/', 'coverage/', 'eslint.config.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Both configs: src/ is covered by tsconfig.json, test/ only by
        // tsconfig.test.json, and type-aware rules need every file in a project.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // --- Correctness that matters for this project -----------------------

      // An unawaited write to a live instance is the whole nightmare scenario:
      // the command reports success and exits while the request is in flight.
      // node:test's describe/it return promises the runner owns; telling the rule
      // about them keeps it strict everywhere else instead of switching it off.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // --- Deliberate relaxations ------------------------------------------

      // ioBroker objects are genuinely dynamic; `unknown` is narrowed at the
      // boundaries in types.ts rather than pretended away everywhere.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',

      // Off on purpose. Almost every report is a guard on data that arrived over
      // a websocket — `socket.emit<T>()` returns `T`, but that type is a claim
      // about what the server *should* send, not a guarantee. The rule sees the
      // declared type and calls `result?.rows ?? []` unnecessary; at runtime a
      // malformed reply makes it essential. Following the rule here would trade
      // a handled edge case for a crash against a live instance.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // `return doSomething()` where the callee returns void reads fine and is
      // used consistently in the command layer.
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // ioBroker represents "unset" as an empty string as often as undefined, so
      // `engineType || '?'` is deliberate: `??` would keep the empty string and
      // silently render a blank column. Strings are exempted rather than the whole
      // rule, so `??` is still enforced where the distinction cannot bite.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true } },
      ],

      // Both uses are `delete record[dynamicKey]` on a Record<string, T> — a
      // credential entry and a manifest entry. That is what the operator is for;
      // the rule targets deleting fixed keys off a shaped object.
      '@typescript-eslint/no-dynamic-delete': 'off',

      // Template literals interpolate ids, paths and counts; stringifying a
      // number is not a bug worth failing a build over.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Commands must route user-facing output through ctx.log, never console.*.
  // This is an AGENTS.md invariant; encoding it here means it is enforced
  // rather than remembered.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // cli.ts is the one place that owns stdout/stderr.
  {
    files: ['src/cli.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Tests assert on shapes the type system cannot see, and reach into internals
  // on purpose.
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  prettier,
);
