import { describe, expect, it } from 'vitest';
import {
  buildGroupControlEntryCard,
  buildGroupControlGoalFormCard,
  buildGroupControlHelpCard,
  buildGroupControlPanelCard,
  buildGroupControlPickerCard,
  type GroupControlPanel,
  type GroupControlSession,
} from '../src/card/group-control-card';

type CardButton = {
  text: { content: string };
  form_action_type?: string;
  behaviors: { type: string; value: Record<string, unknown> }[];
};

function buttons(node: unknown, out: CardButton[] = []): CardButton[] {
  if (Array.isArray(node)) {
    for (const value of node) buttons(value, out);
  } else if (node && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    if (object.tag === 'button') out.push(object as unknown as CardButton);
    for (const value of Object.values(object)) buttons(value, out);
  }
  return out;
}

function visibleTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const value of node) visibleTexts(value, out);
  } else if (node && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    if (typeof object.content === 'string') out.push(object.content);
    for (const value of Object.values(object)) visibleTexts(value, out);
  }
  return out;
}

function values(card: object): Record<string, unknown>[] {
  return buttons(card).map((button) => button.behaviors[0]!.value);
}

function actionIds(card: object): string[] {
  return values(card).map((value) => String(value.a));
}

function makeSession(overrides: Partial<GroupControlSession> = {}): GroupControlSession {
  return {
    key: 'topic-1',
    title: '修复登录问题',
    status: 'idle',
    backendName: 'Codex',
    goalSupported: true,
    settingsSupported: false,
    ...overrides,
  };
}

function makePanel(
  session: Partial<GroupControlSession> = {},
  overrides: Partial<GroupControlPanel> = {},
): GroupControlPanel {
  return {
    token: 'opaque-per-user-token',
    projectName: 'cloud-repo',
    session: makeSession(session),
    ...overrides,
  };
}

describe('buildGroupControlEntryCard', () => {
  it('offers only Sessions and Help, with exact-topic guidance and no destructive entry', () => {
    const card = buildGroupControlEntryCard({ projectName: 'cloud-repo', backendName: 'Codex' });
    expect(values(card)).toEqual([{ a: 'gc.sessions' }, { a: 'gc.help' }]);
    expect(JSON.stringify(card)).toContain('确切话题');
    expect(actionIds(card)).not.toContain('gc.interrupt');
    expect(actionIds(card)).not.toContain('gc.goal.end');
    expect(actionIds(card)).not.toContain('gc.goal.submit');
  });
});

describe('buildGroupControlPickerCard', () => {
  it('shows a clear empty state without selection or paging callbacks', () => {
    const card = buildGroupControlPickerCard({ projectName: 'cloud-repo', token: 'token', sessions: [] });
    expect(JSON.stringify(card)).toContain('暂无可操作的会话');
    expect(buttons(card)).toEqual([]);
  });

  it('labels each selection with title, backend and state, and carries only opaque routing data', () => {
    const session = makeSession({ key: 'topic-key', status: 'goal-running', backendName: 'Claude' });
    const card = buildGroupControlPickerCard({ projectName: 'cloud-repo', token: 'user-token', sessions: [session] });
    const [button] = buttons(card);
    expect(button!.text.content).toContain('修复登录问题');
    expect(button!.text.content).toContain('Claude');
    expect(button!.text.content).toContain('目标运行中');
    expect(button!.behaviors[0]!.value).toEqual({ a: 'gc.select', t: 'user-token', k: 'topic-key' });
  });

  it('bounds pages to ten sessions and emits neighbouring page callbacks', () => {
    const sessions = Array.from({ length: 25 }, (_, index) =>
      makeSession({ key: `topic-${index}`, title: `会话 ${index}` }),
    );
    const first = buildGroupControlPickerCard({ projectName: 'cloud-repo', token: 'token', sessions });
    expect(values(first).filter((value) => value.a === 'gc.select')).toHaveLength(10);
    expect(values(first).filter((value) => value.a === 'gc.page')).toEqual([{ a: 'gc.page', t: 'token', p: 1 }]);

    const middle = buildGroupControlPickerCard({ projectName: 'cloud-repo', token: 'token', sessions, page: 1 });
    expect(values(middle).filter((value) => value.a === 'gc.select')).toHaveLength(10);
    expect(values(middle).filter((value) => value.a === 'gc.page')).toEqual([
      { a: 'gc.page', t: 'token', p: 0 },
      { a: 'gc.page', t: 'token', p: 2 },
    ]);

    const last = buildGroupControlPickerCard({ projectName: 'cloud-repo', token: 'token', sessions, page: 99 });
    expect(values(last).filter((value) => value.a === 'gc.select')).toHaveLength(5);
    expect(values(last).filter((value) => value.a === 'gc.page')).toEqual([{ a: 'gc.page', t: 'token', p: 1 }]);
    expect(JSON.stringify(last)).toContain('第 3/3 页');
  });
});

describe('buildGroupControlPanelCard', () => {
  it('offers continue and goal entry only for an idle goal-capable session', () => {
    const card = buildGroupControlPanelCard(makePanel());
    expect(actionIds(card)).toEqual(['gc.continue', 'gc.goal.form', 'gc.refresh', 'gc.sessions']);
    expect(values(card).find((value) => value.a === 'gc.continue')).toEqual({
      a: 'gc.continue',
      t: 'opaque-per-user-token',
    });
  });

  it('offers ordinary interrupt only for a running session', () => {
    const card = buildGroupControlPanelCard(makePanel({ status: 'running' }));
    expect(actionIds(card)).toEqual(['gc.interrupt', 'gc.refresh', 'gc.sessions']);
    expect(JSON.stringify(card)).toContain('只中断当前普通轮次');
  });

  it('uses explicit goal termination for goal-running and never offers old interrupt', () => {
    const card = buildGroupControlPanelCard(makePanel({ status: 'goal-running', goalObjective: '完成测试' }));
    expect(actionIds(card)).toEqual(['gc.goal.end', 'gc.refresh', 'gc.sessions']);
    expect(buttons(card).find((button) => button.behaviors[0]!.value.a === 'gc.goal.end')!.text.content).toBe(
      '结束目标并停止',
    );
    expect(actionIds(card)).not.toContain('gc.interrupt');
  });

  it('omits goal entry when unsupported and never renders reserved settings controls', () => {
    const unsupported = buildGroupControlPanelCard(makePanel({ goalSupported: false, settingsSupported: true }));
    expect(actionIds(unsupported)).toEqual(['gc.continue', 'gc.refresh', 'gc.sessions']);
    expect(JSON.stringify(unsupported)).not.toContain('gc.settings');
    expect(JSON.stringify(unsupported)).not.toContain('设置');
  });

  it('shows the exact selected session and escapes display text', () => {
    const card = buildGroupControlPanelCard(
      makePanel(
        {
          title: '修复 <b>**登录**</b>',
          backendName: 'Codex',
          status: 'goal-running',
          goalObjective: '检查 <script> 与 **边界**',
        },
        { error: '后端 <b>失败</b>', notice: '请 **刷新**' },
      ),
    );
    const json = JSON.stringify(card);
    expect(json).toContain('修复 &#60;b&#62;&#42;&#42;登录&#42;&#42;&#60;/b&#62;');
    expect(json).toContain('检查 &#60;script&#62; 与 &#42;&#42;边界&#42;&#42;');
    expect(json).toContain('后端 &#60;b&#62;失败&#60;/b&#62;');
    expect(json).toContain('请 &#42;&#42;刷新&#42;&#42;');
    expect(json).not.toContain('<script>');
    expect(json).toContain('目标运行中');
  });
});

describe('buildGroupControlGoalFormCard', () => {
  it('uses the native named input and submit callback contract', () => {
    const card = buildGroupControlGoalFormCard(makePanel({ goalObjective: '完成验收' }));
    const json = JSON.stringify(card);
    expect(json).toContain('"tag":"form"');
    expect(json).toContain('"name":"gc_goal_objective"');
    expect(json).toContain('"default_value":"完成验收"');
    expect(json).toContain('确认后');
    expect(json).toContain('自主目标');

    const submit = buttons(card).find((button) => button.behaviors[0]!.value.a === 'gc.goal.submit');
    expect(submit).toBeDefined();
    expect(submit!.form_action_type).toBe('submit');
    expect(submit!.behaviors[0]).toEqual({
      type: 'callback',
      value: { a: 'gc.goal.submit', t: 'opaque-per-user-token' },
    });
    expect(values(card)).toContainEqual({ a: 'gc.refresh', t: 'opaque-per-user-token' });
  });
});

describe('buildGroupControlHelpCard', () => {
  it('explains operation scope and the ordinary command fallback', () => {
    const card = buildGroupControlHelpCard({ projectName: 'cloud-repo' });
    const json = JSON.stringify(card);
    expect(json).toContain('明确的“继续”指令');
    expect(json).toContain('只中断当前普通轮次');
    expect(json).toContain('结束当前自主目标');
    expect(json).toContain('确切话题');
    expect(json).toContain('/controls');
    expect(actionIds(card)).toEqual(['gc.sessions']);
  });
});

describe('localized menu labels', () => {
  it('uses Chinese visible labels without changing action values', () => {
    const entry = buildGroupControlEntryCard({ projectName: 'cloud-repo', backendName: 'Codex' });
    const idle = buildGroupControlPanelCard(makePanel());
    const running = buildGroupControlPanelCard(makePanel({ status: 'running' }));
    const goalRunning = buildGroupControlPanelCard(makePanel({ status: 'goal-running' }));
    const help = buildGroupControlHelpCard({ projectName: 'cloud-repo' });
    const cards = [entry, idle, running, goalRunning, help];

    for (const card of cards) {
      expect(visibleTexts(card).join('\n')).not.toMatch(/\b(?:sessions|actions|help)\b/i);
    }
    expect(visibleTexts(entry).join('\n')).toContain('会话 / 操作 / 帮助');
    expect(entry).toMatchObject({ config: { summary: { content: '群会话控制' } } });
    expect(cards.map(values)).toEqual([
      [{ a: 'gc.sessions' }, { a: 'gc.help' }],
      [
        { a: 'gc.continue', t: 'opaque-per-user-token' },
        { a: 'gc.goal.form', t: 'opaque-per-user-token' },
        { a: 'gc.refresh', t: 'opaque-per-user-token' },
        { a: 'gc.sessions' },
      ],
      [
        { a: 'gc.interrupt', t: 'opaque-per-user-token' },
        { a: 'gc.refresh', t: 'opaque-per-user-token' },
        { a: 'gc.sessions' },
      ],
      [
        { a: 'gc.goal.end', t: 'opaque-per-user-token' },
        { a: 'gc.refresh', t: 'opaque-per-user-token' },
        { a: 'gc.sessions' },
      ],
      [{ a: 'gc.sessions' }],
    ]);
  });
});
