import type { WidgetDefinition, WidgetLayout, WidgetType } from './types';

export const DESKTOP_LAYOUT_KEY = 'kaoyan-desktop-layout-v1';

export const WIDGET_DEFINITIONS: WidgetDefinition[] = [
  { type: 'schedule', title: '今日课表', description: '显示今天的核心学习安排和完成情况。', defaultWidth: 400, defaultHeight: 710 },
  { type: 'noteDock', title: '笔记暂存', description: '拖拽/粘贴图片保存到桌面笔记目录，支持画布拼接。', defaultWidth: 360, defaultHeight: 82 },
  { type: 'pomodoro', title: '番茄钟', description: '25/5 专注循环，统计今天完成的番茄数。', defaultWidth: 300, defaultHeight: 210 },
  { type: 'countdown', title: '考研倒计时', description: '用天数制造紧迫感，但不制造焦虑。', defaultWidth: 300, defaultHeight: 170 },
  { type: 'topThree', title: '今日三件事', description: '只放今天最重要的三个动作。', defaultWidth: 330, defaultHeight: 220 },
  { type: 'debtBoard', title: '欠账/错题提醒', description: '记录今天需要补的坑和错题来源。', defaultWidth: 340, defaultHeight: 230 },
  { type: 'memoryCard', title: '背诵卡片', description: '放公式、定义、易错点，适合扫一眼。', defaultWidth: 330, defaultHeight: 210 },
  { type: 'reviewLog', title: '复盘记录', description: '写下今天推进了什么、卡在哪里。', defaultWidth: 350, defaultHeight: 240 },
  { type: 'quickLinks', title: '快捷入口', description: '常用学习入口和管理页入口。', defaultWidth: 300, defaultHeight: 190 },
  { type: 'customText', title: '自定义便签', description: '自定义标题和内容，可重复添加多个独立模块。', defaultWidth: 320, defaultHeight: 220 },
  { type: 'customCode', title: 'AI 代码模块', description: '由内置千问生成的交互式 HTML/CSS/JS 小组件。', defaultWidth: 360, defaultHeight: 260 },
];

const makeWidget = (
  id: string,
  type: WidgetType,
  title: string,
  x: number,
  y: number,
  width: number,
  height: number,
  zIndex: number,
): WidgetLayout => ({
  id,
  type,
  title,
  x,
  y,
  width,
  height,
  visible: true,
  zIndex,
});

export const getDefaultLayout = (): WidgetLayout[] => [
  makeWidget('schedule-main', 'schedule', '今日课表', 1110, 34, 400, 700, 10),
  makeWidget('note-dock', 'noteDock', '笔记暂存', 1110, 746, 400, 78, 11),
  makeWidget('pomodoro-main', 'pomodoro', '番茄钟', 42, 42, 310, 214, 4),
  makeWidget('countdown-main', 'countdown', '考研倒计时', 378, 42, 300, 168, 4),
  makeWidget('top-three-main', 'topThree', '今日三件事', 42, 286, 330, 226, 4),
  makeWidget('memory-main', 'memoryCard', '背诵卡片', 400, 260, 330, 214, 4),
  makeWidget('debt-main', 'debtBoard', '欠账/错题提醒', 42, 540, 340, 230, 4),
  makeWidget('review-main', 'reviewLog', '复盘记录', 410, 506, 350, 250, 4),
  makeWidget('links-main', 'quickLinks', '快捷入口', 790, 42, 280, 188, 4),
];

export const getWidgetDefinition = (type: WidgetType): WidgetDefinition => {
  const definition = WIDGET_DEFINITIONS.find((item) => item.type === type);
  if (!definition) {
    throw new Error(`Unknown widget type: ${type}`);
  }
  return definition;
};
