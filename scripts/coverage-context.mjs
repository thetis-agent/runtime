/** Preserve ordinary temporary storage and uninstrumented performance measurements during coverage; ADR 0012, implementation note 0041, implementation note 0042. */
import { stopCoverage } from 'node:v8';

// Node 24.18 marks isolated test children before executing inherited preloads.
// V8 has already captured the parent's private directory before these preloads.
if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  delete process.env.TMPDIR;
  // Node otherwise injects this variable even into explicitly empty child environments.
  delete process.env.NODE_V8_COVERAGE;
  const performanceTests = ['/workspace/test/acceptance-performance.test.ts', '/workspace/test/deployment-assembly.test.ts'];
  if (performanceTests.includes(process.argv[1])) {
    // These tests still execute and enforce their original limits. Profiling would change the quantities they measure.
    stopCoverage();
  }
}
