/**
 * Script to generate service directory scaffolding.
 * Run with: node scripts/create-services.mjs
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

const services = [
  'identity',
  'llm-gateway',
  'voice',
  'vision',
  'control',
  'memory',
  'workflow',
  'code-sandbox',
  'emotion',
  'habit',
  'audit',
  'telemetry',
  'secrets',
  'governance',
  'eval',
  'cost',
  'context-intelligence',
  'cognitive-state',
  'personality',
  'proactive-intelligence',
  'intent-graph',
  'knowledge-grounding',
  'pokg',
  'goal-engine',
  'simulation',
  'reflection',
  'planning',
  'plugin',
  'self-improvement',
  'fine-tuning',
  'research',
  'resource-governor',
  'watchdog',
  'compute-fabric',
  'environment-model',
  'edge-agent',
  'hud-client',
];

function toPackageName(service) {
  return `@may/${service}`;
}

function toPascalCase(str) {
  return str
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

for (const service of services) {
  const serviceDir = join(ROOT, 'services', service);
  const srcDir = join(serviceDir, 'src');
  const interfacesDir = join(srcDir, 'interfaces');
  const typesDir = join(srcDir, 'types');
  const testDir = join(serviceDir, '__tests__');

  // Create directories
  mkdirSync(interfacesDir, { recursive: true });
  mkdirSync(typesDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });

  const pascalName = toPascalCase(service);

  // package.json
  writeFileSync(
    join(serviceDir, 'package.json'),
    JSON.stringify(
      {
        name: toPackageName(service),
        version: '0.1.0',
        private: true,
        description: `${pascalName} service for the May platform`,
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
        scripts: {
          build: 'tsc --build',
          typecheck: 'tsc --noEmit',
          clean: 'rimraf dist *.tsbuildinfo',
          lint: 'eslint src/',
          test: 'vitest run',
          'test:pbt': 'vitest run --testPathPattern=pbt',
        },
        dependencies: {
          '@may/types': '*',
          '@may/utils': '*',
        },
        devDependencies: {
          '@may/testing': '*',
          typescript: '^5.7.0',
          rimraf: '^6.0.0',
          vitest: '^2.1.0',
        },
      },
      null,
      2,
    ),
  );

  // tsconfig.json
  writeFileSync(
    join(serviceDir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*.ts'],
        references: [{ path: '../../packages/types' }, { path: '../../packages/utils' }],
      },
      null,
      2,
    ),
  );

  // src/index.ts
  writeFileSync(
    join(srcDir, 'index.ts'),
    `/**\n * @may/${service} - ${pascalName} Service\n *\n * Entry point for the ${pascalName} service.\n */\n\nexport {};\n`,
  );

  // src/interfaces/index.ts
  writeFileSync(
    join(interfacesDir, 'index.ts'),
    `/**\n * ${pascalName} service interfaces.\n * Service contracts and dependency injection interfaces.\n */\n\nexport {};\n`,
  );

  // src/types/index.ts
  writeFileSync(
    join(typesDir, 'index.ts'),
    `/**\n * ${pascalName} service-specific types.\n * Types that are internal to this service.\n */\n\nexport {};\n`,
  );

  // __tests__/.gitkeep
  writeFileSync(join(testDir, '.gitkeep'), '');

  console.log(`Created service: ${service}`);
}

console.log(`\nDone! Created ${services.length} services.`);
