import { useMemo } from 'react';
import type { WidgetLayout } from './types';
import { buildSafeHtmlArtifact } from '../utils/safeHtmlArtifact';

interface AiCodeModuleSpec {
  html?: string;
  css?: string;
  js?: string;
}

const EMPTY_SPEC: Required<AiCodeModuleSpec> = {
  html: '<div class="empty">这个 AI 模块没有可显示的内容。</div>',
  css: '.empty{padding:16px;color:#f2dec0;font:600 14px/1.6 system-ui,sans-serif}',
  js: '',
};

const parseSpec = (content?: string): Required<AiCodeModuleSpec> => {
  if (!content) {
    return EMPTY_SPEC;
  }
  try {
    const parsed = JSON.parse(content) as AiCodeModuleSpec;
    return {
      html: String(parsed.html || EMPTY_SPEC.html).slice(0, 40000),
      css: String(parsed.css || '').slice(0, 30000),
      js: String(parsed.js || '').slice(0, 30000),
    };
  } catch {
    return {
      ...EMPTY_SPEC,
      html: `<div class="empty">${String(content).replace(/[<&>]/g, '')}</div>`,
    };
  }
};

export function AiCodeWidget({ widget }: { widget: WidgetLayout }) {
  const srcDoc = useMemo(() => buildSafeHtmlArtifact({
    title: widget.title,
    theme: 'dark',
    ...parseSpec(widget.content),
  }), [widget.content, widget.title]);
  return (
    <div className="study-widget-content ai-code-widget">
      <iframe
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={`${widget.title} AI 代码模块`}
      />
    </div>
  );
}
