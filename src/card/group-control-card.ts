import {
  actions,
  button,
  card,
  form,
  hr,
  input,
  md,
  note,
  submitButton,
  type CardElement,
  type CardObject,
} from './cards';

export interface GroupControlSession {
  key: string;
  title: string;
  status: 'idle' | 'running' | 'goal-running';
  backendName: string;
  goalSupported: boolean;
  settingsSupported: boolean;
  goalObjective?: string;
}

export interface GroupControlPanel {
  token: string;
  projectName: string;
  session: GroupControlSession;
  error?: string;
  notice?: string;
}

const PAGE_SIZE = 10;

const STATUS_LABEL: Record<GroupControlSession['status'], string> = {
  idle: '空闲',
  running: '运行中',
  'goal-running': '目标运行中',
};

function escapeText(value: string): string {
  return value.replace(/[&<>*_`\[\]~]/gu, (character) => `&#${String(character.charCodeAt(0))};`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncate(value: string, max: number): string {
  const text = oneLine(value) || '(无标题)';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildGroupControlEntryCard(opts: { projectName: string; backendName: string }): CardObject {
  return card(
    [
      md(`**${escapeText(opts.projectName)}** · ${escapeText(opts.backendName)}`),
      md('请先选择要操作的**确切话题 / 会话**，再执行继续、停止或目标操作。'),
      note('群菜单 会话 / 操作 / 帮助 都回到这里；所有操作只作用于你选中的已有话题。'),
      actions([button('🧵 会话', { a: 'gc.sessions' }), button('❓ 帮助', { a: 'gc.help' })]),
    ],
    { header: { title: '🎛 群会话控制', template: 'blue' }, summary: '群会话控制' },
  );
}

export function buildGroupControlPickerCard(opts: {
  projectName: string;
  token: string;
  sessions: GroupControlSession[];
  page?: number;
}): CardObject {
  const pageCount = Math.max(1, Math.ceil(opts.sessions.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(Math.trunc(opts.page ?? 0) || 0, 0), pageCount - 1);
  const start = currentPage * PAGE_SIZE;
  const visible = opts.sessions.slice(start, start + PAGE_SIZE);
  const elements: CardElement[] = [
    md(`**${escapeText(opts.projectName)}** · 选择确切话题`),
    note('先选择一个已有会话，再打开它的专属操作面板。'),
    hr(),
  ];

  if (visible.length === 0) {
    elements.push(md('_暂无可操作的会话。请先在群话题中 @我 开始一段会话。_'));
  } else {
    for (const session of visible) {
      const label = `${truncate(session.title, 48)} · ${oneLine(session.backendName)} · ${STATUS_LABEL[session.status]}`;
      elements.push(actions([button(label, { a: 'gc.select', t: opts.token, k: session.key })]));
    }
  }

  if (opts.sessions.length > 0) {
    elements.push(note(`共 ${opts.sessions.length} 个会话 · 第 ${currentPage + 1}/${pageCount} 页`));
  }
  if (pageCount > 1) {
    const navigation: CardElement[] = [];
    if (currentPage > 0) {
      navigation.push(button('⬅️ 上一页', { a: 'gc.page', t: opts.token, p: currentPage - 1 }));
    }
    if (currentPage < pageCount - 1) {
      navigation.push(button('下一页 ➡️', { a: 'gc.page', t: opts.token, p: currentPage + 1 }));
    }
    elements.push(actions(navigation));
  }

  return card(elements, {
    header: { title: '🧵 选择会话', template: 'wathet' },
    summary: '选择要操作的会话',
    forward: false,
  });
}

export function buildGroupControlPanelCard(panel: GroupControlPanel): CardObject {
  const { session, token } = panel;
  const controls: CardElement[] = [];
  if (session.status === 'idle') {
    controls.push(button('▶️ 继续', { a: 'gc.continue', t: token }, 'primary'));
    if (session.goalSupported) {
      controls.push(button('🎯 启动自主目标', { a: 'gc.goal.form', t: token }));
    }
  } else if (session.status === 'running') {
    controls.push(button('⏹ 停止当前轮次', { a: 'gc.interrupt', t: token }, 'danger'));
  } else {
    controls.push(button('结束目标并停止', { a: 'gc.goal.end', t: token }, 'danger'));
  }

  const elements: CardElement[] = [
    ...(panel.error ? [md(`❌ **操作失败**：${escapeText(panel.error)}`)] : []),
    ...(panel.notice ? [note(escapeText(panel.notice))] : []),
    md(`**${escapeText(session.title)}**`),
    note(`后端：${escapeText(session.backendName)}　·　状态：${STATUS_LABEL[session.status]}`),
  ];
  if (session.status === 'goal-running' && session.goalObjective) {
    elements.push(md(`目标：${escapeText(session.goalObjective)}`));
  }
  if (session.status === 'running') {
    elements.push(note('停止只中断当前普通轮次；目标运行中的会话不会显示此操作。'));
  } else if (session.status === 'goal-running') {
    elements.push(note('「结束目标并停止」会终止当前自主目标及其运行。'));
  }
  elements.push(
    actions(controls),
    hr(),
    actions([button('🔄 刷新', { a: 'gc.refresh', t: token }), button('⬅️ 返回 会话', { a: 'gc.sessions' })]),
  );

  return card(elements, {
    header: { title: '🎛 会话操作', template: session.status === 'idle' ? 'green' : 'blue' },
    summary: `会话操作 · ${STATUS_LABEL[session.status]}`,
    forward: false,
  });
}

export function buildGroupControlGoalFormCard(panel: GroupControlPanel): CardObject {
  const { session, token } = panel;
  return card(
    [
      ...(panel.error ? [md(`❌ **无法启动目标**：${escapeText(panel.error)}`)] : []),
      md(`**${escapeText(session.title)}**`),
      note(`后端：${escapeText(session.backendName)}`),
      md('填写目标并提交确认后，将在这个已有话题中启动自主目标，连续执行多轮直到完成或被结束。'),
      form('group_control_goal', [
        input({
          name: 'gc_goal_objective',
          label: '目标内容',
          placeholder: '描述要自主完成的任务与验收标准',
          value: session.goalObjective,
          required: true,
          inputType: 'multiline_text',
          rows: 6,
          width: 'fill',
          maxLength: 1000,
        }),
        actions([
          submitButton('✅ 确认并启动自主目标', { a: 'gc.goal.submit', t: token }, 'primary', 'submit_group_control_goal'),
        ]),
      ]),
      actions([button('⬅️ 取消并返回', { a: 'gc.refresh', t: token })]),
    ],
    { header: { title: '🎯 启动自主目标', template: 'blue' }, summary: '启动自主目标', widthMode: 'fill', forward: false },
  );
}

export function buildGroupControlHelpCard(opts: { projectName: string }): CardObject {
  return card(
    [
      md(`**${escapeText(opts.projectName)}** · 群会话操作说明`),
      md(
        [
          '· **继续**：向选中的已有话题发送一条明确的“继续”指令。',
          '· **停止当前轮次**：只中断当前普通轮次，不用于目标运行。',
          '· **结束目标并停止**：结束当前自主目标，同时停止它的运行。',
          '· **作用范围**：所有操作只针对你先选中的确切话题，不会新建或切换其他话题。',
          '· **命令兜底**：卡片不可用时，可在对应话题中使用 `/controls`。',
        ].join('\n'),
      ),
      actions([button('🧵 选择 会话', { a: 'gc.sessions' })]),
    ],
    { header: { title: '❓ 群会话帮助', template: 'blue' }, summary: '群会话操作说明' },
  );
}
