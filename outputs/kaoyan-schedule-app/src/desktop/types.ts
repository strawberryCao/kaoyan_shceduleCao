export type WidgetType =
  | 'schedule'
  | 'noteDock'
  | 'pomodoro'
  | 'countdown'
  | 'topThree'
  | 'debtBoard'
  | 'memoryCard'
  | 'reviewLog'
  | 'quickLinks'
  | 'customText'
  | 'customCode';

export interface WidgetLayout {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  zIndex: number;
  content?: string;
}

export interface WidgetDefinition {
  type: WidgetType;
  title: string;
  description: string;
  defaultWidth: number;
  defaultHeight: number;
}
