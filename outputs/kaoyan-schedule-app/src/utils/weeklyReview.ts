import type { ScheduleDay } from '../types';
import type { LearningAutoNote, LearningCard, LearningDataSnapshot } from './learningData';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUBJECTS = new Set(['默认文件夹', '未分类', '默认', '收件箱']);

export interface WeeklyReviewStats {
  noteCount: number;
  mistakeCount: number;
  memoryCount: number;
  uncategorizedCount: number;
  completedTasks: number;
  plannedTasks: number;
  completionRate: number;
  reviewedCards: number;
  dueCards: number;
  trackedScheduleDays: number;
  elapsedScheduleDays: number;
}

export interface WeeklyReviewPackage {
  weekStart: string;
  weekEnd: string;
  rangeLabel: string;
  stats: WeeklyReviewStats;
  markdown: string;
}

const parseDate = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

export const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const addDays = (value: string, amount: number): string => {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return formatDate(date);
};

export const getWeekStart = (value = formatDate(new Date())): string => {
  const date = parseDate(value);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return formatDate(date);
};

export const shiftWeek = (weekStart: string, direction: -1 | 1): string => addDays(weekStart, direction * 7);

const inRange = (value: string, start: string, end: string): boolean => value >= start && value <= end;
const clean = (value: unknown, max = 360): string => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);
const unique = (values: Array<string | null | undefined>): string[] => [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))];

const pageText = (note: LearningAutoNote): string => note.pageRefs
  .map((ref) => clean(ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '), 80))
  .filter(Boolean)
  .join('、');

const knowledgePoints = (note: LearningAutoNote): string[] => unique([
  ...note.knowledgePath.filter((item) => item !== note.subject),
  ...note.items.map((item) => item.knowledgePoint),
]);

const wrongReasons = (note: LearningAutoNote): string[] => unique([
  note.wrongReason,
  ...note.items.map((item) => item.wrongReason),
  ...note.tags.filter((tag) => /^错因[:：]/.test(tag)).map((tag) => tag.replace(/^错因[:：]\s*/, '')),
]);

const questionTypes = (note: LearningAutoNote): string[] => unique([
  note.questionType,
  ...note.items.map((item) => item.questionType),
  ...note.tags.filter((tag) => /^题型[:：]/.test(tag)).map((tag) => tag.replace(/^题型[:：]\s*/, '')),
]);

const isMistake = (note: LearningAutoNote): boolean => note.noteType === 'mistake'
  || note.tags.some((tag) => /错题|易错/.test(tag))
  || wrongReasons(note).length > 0
  || note.items.some((item) => item.intent.isMistake)
  || /错题|错因|做错|算错|不会|粗心/.test(note.remark);

const isMemory = (note: LearningAutoNote): boolean => note.noteType === 'memory'
  || note.tags.some((tag) => /背诵|记忆|要背|记住/.test(tag))
  || note.items.some((item) => item.intent.shouldMemorize)
  || /(?:要记住|需要记|必须记|背下来|需要背|必须背|熟记)/.test(note.remark);

const isGood = (note: LearningAutoNote): boolean => note.noteType === 'good'
  || note.tags.some((tag) => /好题|经典题|典型题|精品题/.test(tag));

const isLikelyLearning = (note: LearningAutoNote): boolean => !DEFAULT_SUBJECTS.has(note.subject)
  || isMistake(note)
  || isMemory(note)
  || note.pageRefs.length > 0
  || knowledgePoints(note).length > 0
  || questionTypes(note).length > 0
  || /题|知识|公式|证明|定义|定理|单词|英语|数学|计算机|背/.test(note.remark);

const countValues = (values: string[]): Array<[string, number]> => {
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
};

const topText = (values: string[], limit = 8): string => {
  const rows = countValues(values).slice(0, limit);
  return rows.length > 0 ? rows.map(([name, count]) => `${name}（${count}）`).join('、') : '无明确记录';
};

const allNotes = (snapshot: LearningDataSnapshot): Array<{ date: string; note: LearningAutoNote }> => {
  const entries = Object.entries(snapshot.days).flatMap(([date, day]) => day.autoNotes
    .filter((note) => note.organizationStatus !== 'ignored' && !DEFAULT_SUBJECTS.has(note.subject.trim()))
    .map((note) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(note.capturedDate) ? note.capturedDate : date,
    note,
  })));
  const deduped = new Map<string, { date: string; note: LearningAutoNote }>();
  entries.forEach((entry) => {
    const key = [
      entry.date,
      clean(entry.note.subject, 60),
      clean(entry.note.title, 160),
      clean(entry.note.remark, 500),
      pageText(entry.note),
    ].join('|').toLocaleLowerCase('zh-CN');
    const previous = deduped.get(key);
    const richness = entry.note.items.length * 4 + entry.note.tags.length + entry.note.knowledgePath.length;
    const previousRichness = previous
      ? previous.note.items.length * 4 + previous.note.tags.length + previous.note.knowledgePath.length
      : -1;
    if (!previous || richness > previousRichness) deduped.set(key, entry);
  });
  return [...deduped.values()]
    .sort((left, right) => left.date.localeCompare(right.date) || left.note.createdAt.localeCompare(right.note.createdAt));
};

const noteLine = ({ date, note }: { date: string; note: LearningAutoNote }): string => {
  const labels = [isMistake(note) ? '错题' : '', isGood(note) ? '好题' : '', isMemory(note) ? '需记忆' : ''].filter(Boolean).join('+')
    || (isLikelyLearning(note) ? '普通学习笔记' : '疑似非学习内容');
  const summaries = unique(note.items.map((item) => item.summary)).slice(0, 3).join('；');
  const recentThoughts = note.studyNotes.slice(-5).map((thought) => clean(thought.text, 500));
  return [
    `- [${date}] ${clean(DEFAULT_SUBJECTS.has(note.subject) ? '未分类' : note.subject, 60)}｜${clean(note.title || note.remark || '未命名笔记', 120)}`,
    pageText(note) ? `页码/题号：${pageText(note)}` : '',
    knowledgePoints(note).length ? `知识点：${knowledgePoints(note).join('、')}` : '',
    questionTypes(note).length ? `题型：${questionTypes(note).join('、')}` : '',
    wrongReasons(note).length ? `错因：${wrongReasons(note).join('；')}` : '',
    note.remark ? `我的备注：${clean(note.remark, 420)}` : '',
    recentThoughts.length ? `历次学习想法（共 ${note.studyNotes.length} 条，最近优先）：${recentThoughts.reverse().join('｜')}` : '',
    summaries ? `内容摘要：${clean(summaries, 600)}` : '',
    `性质：${labels}`,
  ].filter(Boolean).join('；');
};

const thoughtDate = (value: string): string => /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';

const thoughtLine = ({ date, note, text }: { date: string; note: LearningAutoNote; text: string }): string => [
  `- [${date}] ${clean(DEFAULT_SUBJECTS.has(note.subject) ? '未分类' : note.subject, 60)}｜${clean(note.title || note.remark || '未命名笔记', 120)}`,
  `我的新想法：${clean(text, 700)}`,
].join('；');

const cardSubject = (card: LearningCard): string => {
  if (card.subject && !DEFAULT_SUBJECTS.has(card.subject)) return card.subject;
  const parts = card.sourceFilePath.split(/[\\/]/).filter(Boolean);
  const folder = parts.length > 1 ? parts[parts.length - 2] : '';
  return folder && !DEFAULT_SUBJECTS.has(folder) && folder !== '笔记' ? folder : '未分类';
};

const cardLine = (card: LearningCard): string => [
  `- ${card.kind === 'mistake' ? '错题卡' : '背诵卡'}｜${clean(cardSubject(card), 60)}`,
  `问题：${clean(card.front || card.sourceTitle || '未填写', 360)}`,
  `答案：${clean(card.back || '未填写', 700)}`,
  card.knowledgePath.length ? `知识路径：${card.knowledgePath.join(' / ')}` : '',
  `状态：${card.status === 'active' ? '复习中' : card.status === 'draft' ? '草稿' : '已归档'}`,
].filter(Boolean).join('；');

const weekDates = (weekStart: string): string[] => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

export function buildWeeklyReviewPackage(
  snapshot: LearningDataSnapshot,
  scheduleDays: ScheduleDay[],
  weekStart: string,
  today = formatDate(new Date()),
): WeeklyReviewPackage {
  const weekEnd = addDays(weekStart, 6);
  const asOfDate = today < weekStart ? weekStart : today > weekEnd ? weekEnd : today;
  const dates = weekDates(weekStart);
  const scheduleByDate = new Map(scheduleDays.map((day) => [day.date, day]));
  const notes = allNotes(snapshot);
  const eligibleNoteUids = new Set(notes.map(({ note }) => note.noteUid));
  const currentNotes = notes.filter((entry) => inRange(entry.date, weekStart, weekEnd));
  const historyStart = addDays(weekStart, -28);
  const historyEnd = addDays(weekStart, -1);
  const historyNotes = notes.filter((entry) => inRange(entry.date, historyStart, historyEnd));
  const thoughtEntries = notes.flatMap(({ note }) => note.studyNotes.map((thought) => ({
    note,
    date: thoughtDate(thought.updatedAt || thought.createdAt),
    text: thought.text,
  }))).filter((entry) => entry.date);
  const currentThoughts = thoughtEntries.filter((entry) => inRange(entry.date, weekStart, weekEnd));
  const historicalThoughts = thoughtEntries.filter((entry) => inRange(entry.date, historyStart, historyEnd));

  let completedTasks = 0;
  let plannedTasks = 0;
  let trackedScheduleDays = 0;
  let elapsedScheduleDays = 0;
  const dailyRows = dates.map((date) => {
    const schedule = scheduleByDate.get(date);
    const manual = snapshot.days[date]?.manual;
    const isFuture = date > asOfDate;
    const trackable = schedule?.tasks.filter((task) => task.trackable) ?? [];
    const hasTrackingData = Boolean(manual && (
      manual.completedTaskIds.length > 0
      || manual.note.trim()
      || manual.debt.trim()
      || manual.mistakes.trim()
    ));
    const completed = isFuture ? [] : trackable.filter((task) => manual?.completedTaskIds.includes(task.id));
    const unfinished = isFuture || !hasTrackingData ? [] : trackable.filter((task) => !manual?.completedTaskIds.includes(task.id));
    if (!isFuture && schedule) elapsedScheduleDays += 1;
    if (!isFuture && hasTrackingData) {
      trackedScheduleDays += 1;
      completedTasks += completed.length;
      plannedTasks += trackable.length;
    }
    const detail = [
      schedule ? `${schedule.weekday}·${schedule.type}日` : '无课表数据',
      isFuture ? '尚未到达' : hasTrackingData ? `已记录完成 ${completed.length}/${trackable.length}` : '无课表勾选数据（不能据此判断未学习）',
      completed.length ? `完成：${completed.map((task) => task.title).join('、')}` : '',
      unfinished.length ? `未完成：${unfinished.map((task) => task.title).join('、')}` : '',
      manual?.note ? `每日备注：${clean(manual.note, 500)}` : '',
      manual?.debt ? `欠账：${clean(manual.debt, 500)}` : '',
      manual?.mistakes ? `错题记录：${clean(manual.mistakes, 500)}` : '',
    ].filter(Boolean).join('；');
    return `- ${date}｜${detail}`;
  });

  const uniqueCards = [...new Map(snapshot.cards.filter((card) => eligibleNoteUids.has(card.noteUid)).map((card) => [[
    card.kind,
    clean(card.front, 500),
    clean(card.back, 800),
    cardSubject(card),
  ].join('|').toLocaleLowerCase('zh-CN'), card])).values()];
  const reviewedCards = uniqueCards.filter((card) => card.lastReviewedAt && inRange(card.lastReviewedAt.slice(0, 10), weekStart, weekEnd));
  const dueCards = uniqueCards.filter((card) => card.status === 'active' && (!card.dueDate || card.dueDate <= asOfDate));
  const rawRelevantCards = uniqueCards.filter((card) => {
    const sourceNote = currentNotes.some(({ note }) => note.noteUid === card.noteUid);
    const createdThisWeek = card.createdAt && inRange(card.createdAt.slice(0, 10), weekStart, weekEnd);
    return sourceNote || createdThisWeek || reviewedCards.some((item) => item.id === card.id);
  });
  const relevantCards = [...new Map(rawRelevantCards.map((card) => [[
    card.kind,
    clean(card.front, 500),
    clean(card.back, 800),
    cardSubject(card),
  ].join('|').toLocaleLowerCase('zh-CN'), card])).values()].slice(0, 40);

  const mistakeNotes = currentNotes.filter(({ note }) => isMistake(note));
  const memoryNotes = currentNotes.filter(({ note }) => isMemory(note));
  const uncategorizedNotes = currentNotes.filter(({ note }) => !isMistake(note) && !isGood(note) && !isMemory(note));
  const completionRate = plannedTasks ? Math.round((completedTasks / plannedTasks) * 100) : 0;
  const stats: WeeklyReviewStats = {
    noteCount: currentNotes.length,
    mistakeCount: mistakeNotes.length,
    memoryCount: memoryNotes.length,
    uncategorizedCount: uncategorizedNotes.length,
    completedTasks,
    plannedTasks,
    completionRate,
    reviewedCards: reviewedCards.length,
    dueCards: dueCards.length,
    trackedScheduleDays,
    elapsedScheduleDays,
  };

  const historicalWeeks = Array.from({ length: 4 }, (_, index) => {
    const start = addDays(weekStart, -(index + 1) * 7);
    const end = addDays(start, 6);
    const entries = historyNotes.filter((entry) => inRange(entry.date, start, end));
    const mistakes = entries.filter(({ note }) => isMistake(note)).length;
    const memories = entries.filter(({ note }) => isMemory(note)).length;
    return `- ${start} 至 ${end}：笔记 ${entries.length}，错题 ${mistakes}，需记忆 ${memories}`;
  });

  const historySubjects = historyNotes.map(({ note }) => DEFAULT_SUBJECTS.has(note.subject) ? '未分类' : note.subject);
  const historyKnowledge = historyNotes.flatMap(({ note }) => knowledgePoints(note));
  const historyWrongReasons = historyNotes.flatMap(({ note }) => wrongReasons(note));
  const currentLines = currentNotes.length
    ? currentNotes.slice(0, 80).map(noteLine)
    : ['- 本周没有自动笔记记录。'];
  if (currentNotes.length > 80) currentLines.push(`- 另有 ${currentNotes.length - 80} 条笔记因长度限制未展开。`);
  const cardLines = relevantCards.length ? relevantCards.map(cardLine) : ['- 本周没有相关卡片。'];
  const currentThoughtLines = currentThoughts.length
    ? currentThoughts.slice(-60).map(thoughtLine)
    : ['- 本周没有新增学习想法。'];
  const historicalThoughtLines = historicalThoughts.length
    ? historicalThoughts.slice(-60).map(thoughtLine)
    : ['- 过去四周没有新增学习想法。'];

  const markdown = [
    '# 考研学习周复盘：交给 GPT 的资料包',
    '',
    `复盘范围：${weekStart} 至 ${weekEnd}（本周为主）`,
    `历史参考：${historyStart} 至 ${historyEnd}（只用于识别趋势）`,
    '',
    '## 给 GPT 的任务',
    '',
    '你是严谨的考研学习诊断顾问。请基于下面的结构化资料完成周复盘。本周证据权重约占 80%，过去四周趋势约占 20%。',
    '',
    '请完成：',
    '1. 用简洁语言总结本周实际学习状态，不要复述全部流水账。',
    '2. 挖掘 3—6 个潜在问题。每个问题必须写出证据、影响、置信度，并给出至少一种其他可能解释。',
    '3. 找出反复出现的薄弱知识点、题型或错因；只有出现至少两条独立证据时才称为“重复模式”。',
    '4. 输出“需要强化记忆”清单，最多 12 项。每项包含：要记什么、为什么、来源、推荐的主动回忆问题。',
    '5. 输出“下周需要注意”清单，区分知识问题、做题习惯、时间安排和复习机制。',
    '6. 给出最多 5 条下周行动建议，必须具体、可执行、能检查是否完成，并与现有课表兼容。',
    '7. 把“我的学习想法”视为用户在重做或回看后的高优先级证据；综合同一笔记的历次想法，指出理解如何变化，不要覆盖或改写用户原话。',
    '',
    '分析约束：',
    '- 事实与推断分开写；引用证据时标注日期和笔记标题。',
    '- 不要因为某天没有记录就断言我没有学习；可以标记为“数据缺失”。',
    '- 标为“疑似非学习内容”的笔记不要计入学习表现，也不要据此推断知识薄弱。',
    '- 相同标题和备注的重复索引已在资料包中合并，频次判断只使用去重后的记录。',
    '- 不要输出空泛鼓励、人格判断或医学诊断。',
    '- 错题、需要背诵的内容和普通参考笔记必须分开处理。',
    '- 如果资料不足以判断，直接写“无法判断”，并说明还缺什么信息。',
    '- 优先发现我自己未必意识到、但能由多条证据支持的问题。',
    '',
    '请按以下结构输出：',
    'A. 本周结论（不超过 200 字）',
    'B. 潜在问题与证据',
    'C. 重复薄弱模式',
    'D. 强化记忆清单',
    'E. 下周注意事项',
    'F. 下周 5 项行动计划',
    'G. 数据局限',
    '',
    '---',
    '# 学习资料',
    '',
    '## 本周概览',
    '',
    `- 有勾选数据的课表完成：${completedTasks}/${plannedTasks}（${completionRate}%）`,
    `- 课表勾选覆盖：${trackedScheduleDays}/${elapsedScheduleDays} 个已到达的课表日；其余日期不能据此判断是否学习`,
    `- 新增笔记：${currentNotes.length}`,
    `- 错题笔记：${mistakeNotes.length}`,
    `- 需记忆笔记：${memoryNotes.length}`,
    `- 未归入错题/好题/背诵：${uncategorizedNotes.length}（已列入“未分类笔记”栏目）`,
    `- 本周复习过的卡片：${reviewedCards.length}`,
    `- 当前到期卡片：${dueCards.length}`,
    '',
    '## 每日学习与课表',
    '',
    ...dailyRows,
    '',
    '## 本周笔记',
    '',
    ...currentLines,
    '',
    '## 本周相关复习卡片',
    '',
    ...cardLines,
    '',
    '## 本周新增或修改的学习想法',
    '',
    ...currentThoughtLines,
    '',
    '## 过去四周的学习想法',
    '',
    ...historicalThoughtLines,
    '',
    '## 过去四周压缩趋势',
    '',
    ...historicalWeeks,
    `- 常见科目：${topText(historySubjects)}`,
    `- 常见知识点：${topText(historyKnowledge)}`,
    `- 常见错因：${topText(historyWrongReasons)}`,
    '',
    '--- 资料结束 ---',
  ].join('\n');

  return {
    weekStart,
    weekEnd,
    rangeLabel: `${weekStart} 至 ${weekEnd}`,
    stats,
    markdown,
  };
}

export const weeklyReviewFilename = (weekStart: string): string => `考研周复盘_${weekStart}.md`;
