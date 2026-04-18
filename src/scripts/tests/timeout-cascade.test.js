function parseTimeout(testCase, index) {
  return testCase.execution?.timeout_s || index.execution?.default_timeout_s || 300;
}

function testTimeoutCascade() {
  const index = { execution: { default_timeout_s: 300 } };
  
  const testCases = [
    { name: 'TC-001', execution: { timeout_s: 600 } },
    { name: 'TC-002', execution: {} },
    { name: 'TC-003' }
  ];
  
  const results = testCases.map(tc => ({
    case: tc.name,
    timeout: parseTimeout(tc, index)
  }));
  
  console.log('Timeout cascade results:', results);
  
  const expected = [600, 300, 300];
  const passed = results.every((r, i) => r.timeout === expected[i]);
  
  console.log(`Test ${passed ? 'PASSED' : 'FAILED'}`);
  process.exit(passed ? 0 : 1);
}

testTimeoutCascade();