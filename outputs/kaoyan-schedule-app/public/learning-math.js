(() => {
  'use strict';

  const TARGET_SELECTOR = [
    '.learning-center .lc-detail-heading h2',
    '.learning-center .lc-note-button-title',
    '.learning-center .lc-detail-section > p',
    '.learning-center .lc-detail-items strong',
    '.learning-center .lc-detail-items p',
    '.learning-center .lc-thought-list p',
    '.learning-center .lc-queue-list button > span:first-child',
    '.learning-center .lc-flip-card p',
    '.learning-center .lc-good-import-list strong',
  ].join(',');

  const COMMAND_SYMBOLS = Object.freeze({
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    infty: '∞', partial: '∂', nabla: '∇', pm: '±', mp: '∓', times: '×', div: '÷',
    cdot: '·', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
    equiv: '≡', propto: '∝', to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    implies: '⇒', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
    supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
    sum: '∑', prod: '∏', int: '∫', iint: '∬', iiint: '∭', lim: 'lim',
  });

  const FUNCTION_NAMES = new Set([
    'ln', 'log', 'lg', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
    'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'max', 'min', 'det', 'exp',
  ]);

  const SPACING_COMMANDS = new Set([',', ';', ':', '!', 'quad', 'qquad', 'enspace', 'thinspace']);
  const renderedSources = new WeakMap();

  function textNode(value) {
    return document.createTextNode(value);
  }

  function span(className, ...children) {
    const element = document.createElement('span');
    if (className) element.className = className;
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === '') return;
      element.append(child instanceof Node ? child : textNode(String(child)));
    });
    return element;
  }

  function appendBreakOpportunity(fragment, token) {
    fragment.append(textNode(token));
    if (['=', '+', '-', '−', '→', '⇒', '⇔', ',', '，', ';', '；'].includes(token)) {
      fragment.append(document.createElement('wbr'));
    }
  }

  function normalizeFormulaSource(value) {
    return value
      .replace(/＼/g, '\\')
      .replace(/\\dfrac\b/g, '\\frac')
      .replace(/\\tfrac\b/g, '\\frac')
      .replace(/(?<![A-Za-z0-9}])([0-9]+)_([A-Za-z](?:\{[^{}]+\}|[A-Za-z0-9])*)/g, '\\frac{$1}{$2}')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseFormula(rawSource) {
    const source = normalizeFormulaSource(rawSource);
    let index = 0;

    function readCommandName() {
      index += 1;
      if (index >= source.length) return '';
      if (!/[A-Za-z]/.test(source[index])) return source[index++];
      const start = index;
      while (index < source.length && /[A-Za-z]/.test(source[index])) index += 1;
      return source.slice(start, index);
    }

    function skipSpaces() {
      while (index < source.length && /\s/.test(source[index])) index += 1;
    }

    function parseGroupOrAtom() {
      skipSpaces();
      if (source[index] === '{') {
        index += 1;
        const group = parseSequence('}');
        if (source[index] === '}') index += 1;
        return span('lc-math-group', group);
      }
      return parseAtom();
    }

    function parseCommand() {
      const command = readCommandName();
      if (!command) return textNode('\\');
      if (SPACING_COMMANDS.has(command)) return textNode(' ');
      if (command === 'left' || command === 'right') {
        skipSpaces();
        if (index < source.length) return textNode(source[index++]);
        return textNode('');
      }
      if (command === 'frac') {
        const numerator = parseGroupOrAtom();
        const denominator = parseGroupOrAtom();
        return span(
          'lc-math-frac',
          span('lc-math-frac-num', numerator),
          span('lc-math-frac-den', denominator),
        );
      }
      if (command === 'sqrt') {
        const radicand = parseGroupOrAtom();
        return span('lc-math-root', span('lc-math-root-symbol', '√'), span('lc-math-radicand', radicand));
      }
      if (command === 'operatorname' || command === 'mathrm' || command === 'text') {
        const content = parseGroupOrAtom();
        return span(command === 'text' ? 'lc-math-text' : 'lc-math-function', content);
      }
      if (FUNCTION_NAMES.has(command)) return span('lc-math-function', command);
      if (Object.prototype.hasOwnProperty.call(COMMAND_SYMBOLS, command)) {
        const symbol = COMMAND_SYMBOLS[command];
        return FUNCTION_NAMES.has(symbol) || symbol === 'lim'
          ? span('lc-math-function', symbol)
          : textNode(symbol);
      }
      return span('lc-math-unknown-command', command);
    }

    function parseAtom() {
      if (index >= source.length) return textNode('');
      const char = source[index];
      if (char === '\\') return parseCommand();
      if (char === '{') {
        index += 1;
        const group = parseSequence('}');
        if (source[index] === '}') index += 1;
        return span('lc-math-group', group);
      }
      if (/[A-Za-z]/.test(char)) {
        const start = index;
        while (index < source.length && /[A-Za-z]/.test(source[index])) index += 1;
        const word = source.slice(start, index);
        return FUNCTION_NAMES.has(word)
          ? span('lc-math-function', word)
          : span('lc-math-variable', word);
      }
      if (/[0-9.]/.test(char)) {
        const start = index;
        while (index < source.length && /[0-9.]/.test(source[index])) index += 1;
        return textNode(source.slice(start, index));
      }
      index += 1;
      return textNode(char);
    }

    function parseScriptValue() {
      skipSpaces();
      return parseGroupOrAtom();
    }

    function parseSequence(stopCharacter) {
      const fragment = document.createDocumentFragment();
      while (index < source.length && source[index] !== stopCharacter) {
        if (/\s/.test(source[index])) {
          index += 1;
          fragment.append(textNode(' '));
          continue;
        }

        let atom = parseAtom();
        let subscript = null;
        let superscript = null;
        skipSpaces();
        while (source[index] === '_' || source[index] === '^') {
          const marker = source[index++];
          const value = parseScriptValue();
          if (marker === '_') subscript = value;
          else superscript = value;
          skipSpaces();
        }

        if (subscript || superscript) {
          atom = span(
            'lc-math-script',
            span('lc-math-script-base', atom),
            subscript ? span('lc-math-sub', subscript) : null,
            superscript ? span('lc-math-sup', superscript) : null,
          );
        }

        if (atom.nodeType === Node.TEXT_NODE && atom.textContent && atom.textContent.length === 1) {
          appendBreakOpportunity(fragment, atom.textContent);
        } else {
          fragment.append(atom);
        }
      }
      return fragment;
    }

    const expression = span('lc-math-expression', parseSequence(''));
    expression.setAttribute('role', 'math');
    expression.setAttribute('aria-label', rawSource);
    expression.title = rawSource;
    return expression;
  }

  function splitExplicitMath(source) {
    const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
    const parts = [];
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match.index > cursor) parts.push({ math: false, value: source.slice(cursor, match.index) });
      const token = match[0];
      const value = token.startsWith('$$')
        ? token.slice(2, -2)
        : token.startsWith('\\[') || token.startsWith('\\(')
          ? token.slice(2, -2)
          : token.slice(1, -1);
      parts.push({ math: true, value });
      cursor = match.index + token.length;
    }
    if (cursor < source.length) parts.push({ math: false, value: source.slice(cursor) });
    return parts;
  }

  function looksLikeBareMath(source) {
    return /\\(?:frac|sqrt|lim|ln|log|sin|cos|tan|alpha|beta|theta|pi|infty|sum|int)\b/.test(source)
      || /[_^](?:\{|[A-Za-z0-9])/.test(source)
      || /(?:^|[^A-Za-z])[A-Za-z][A-Za-z0-9]*(?:\([^)]*\))?\s*=\s*[^=]/.test(source);
  }

  function renderSource(source) {
    const fragment = document.createDocumentFragment();
    const explicitParts = splitExplicitMath(source);
    const hasExplicitMath = explicitParts.some((part) => part.math);

    if (hasExplicitMath) {
      explicitParts.forEach((part) => {
        fragment.append(part.math ? parseFormula(part.value) : textNode(part.value));
      });
      return fragment;
    }

    if (looksLikeBareMath(source)) {
      fragment.append(parseFormula(source));
      return fragment;
    }

    fragment.append(textNode(source));
    return fragment;
  }

  function renderElement(element) {
    if (!(element instanceof HTMLElement)) return;
    if (element.closest('input, textarea, select, code, pre, script, style, svg')) return;

    const hasRenderedMath = Boolean(element.querySelector(':scope .lc-math-expression'));
    if (hasRenderedMath && renderedSources.has(element)) return;

    const source = element.textContent || '';
    if (!source.trim()) return;
    if (!looksLikeBareMath(source) && !splitExplicitMath(source).some((part) => part.math)) {
      renderedSources.delete(element);
      return;
    }

    element.replaceChildren(renderSource(source));
    renderedSources.set(element, source);
    element.dataset.learningMathRendered = 'true';
  }

  function collectTargets(root) {
    const targets = new Set();
    if (root instanceof Element) {
      if (root.matches(TARGET_SELECTOR)) targets.add(root);
      root.querySelectorAll(TARGET_SELECTOR).forEach((element) => targets.add(element));
      const closest = root.closest(TARGET_SELECTOR);
      if (closest) targets.add(closest);
    } else if (root instanceof Document) {
      root.querySelectorAll(TARGET_SELECTOR).forEach((element) => targets.add(element));
    }
    return targets;
  }

  function process(root = document) {
    collectTargets(root).forEach(renderElement);
  }

  function start() {
    process(document);
    const observer = new MutationObserver((records) => {
      const roots = new Set();
      records.forEach((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target || target.closest('.lc-math-expression')) return;
        roots.add(target);
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) roots.add(node);
        });
      });
      roots.forEach(process);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
