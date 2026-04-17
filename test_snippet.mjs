    mkdirSync(dirname(currentMeta), { recursive: true });
    writeFileSync(currentMeta, makeMetaJson('passed'));
    const meta = makeMetaJson('failed');
    const mocks = {};
    mocks[`TEST_REF:src/skills/${VERDICT_SKILL}/tests/cases/TC-V009/current/meta.json`] = meta;
    writeFileSync(mockFile, JSON.stringify(mocks));
    const { stdout } = await runVerdict(['--skill', VERDICT_SKILL, '--layer', 'static', '--baseline-ref', 'TEST_REF'], mockFile);
    const comp = parseGitHeadComparison(stdout);
    assert.strictEqual(comp.previously_red_now_green, 1, 'previously_red_now_green должен быть 1');
    rmSync(mockFile, { force: true });
  });
});

// ============================================================================
// No git write-операции
// ============================================================================

describe('Нет git write-операций', () => {
  it('runner не содержит "git add"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git add'), 'runner не должен содержать "git add"');
  });

  it('runner не содержит "git commit"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git commit'), 'runner не должен содержать "git commit"');
  });

it('runner не содержит "git push"', () => {
    const source = readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!source.includes('git push'), 'runner не должен содержать "git push"');
  });
});