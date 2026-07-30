(() => {
  if (globalThis.__KAOYAN_DRAG_RELAY_INSTALLED__) return;
  globalThis.__KAOYAN_DRAG_RELAY_INSTALLED__ = true;

  const MIME = 'application/x-kaoyan-material-v1';
  const TEXT_PREFIX = 'KAOYAN_MATERIAL_V1:';
  const MESSAGE = Object.freeze({
    capture: 'KAOYAN_RELAY_CAPTURE_VISIBLE_TAB',
    resolve: 'KAOYAN_RELAY_RESOLVE_TRANSFER',
    open: 'KAOYAN_RELAY_OPEN_ASSET',
  });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const mix = (left, right, amount) => left + (right - left) * amount;
  const smoothstep = (edge0, edge1, value) => {
    const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return amount * amount * (3 - 2 * amount);
  };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  const typeList = (dataTransfer) => Array.from(dataTransfer?.types || [], (value) => String(value).toLowerCase());
  const itemTypeList = (dataTransfer) => Array.from(dataTransfer?.items || [], (item) => String(item.type || '').toLowerCase());
  const recognizesRelay = (dataTransfer) => (
    typeList(dataTransfer).includes(MIME)
    || itemTypeList(dataTransfer).includes(MIME)
  );

  const decodeBase64Url = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  const parseDescriptor = async (dataTransfer) => {
    let serialized = dataTransfer.getData(MIME);
    if (!serialized) {
      const plain = dataTransfer.getData('text/plain');
      if (plain.startsWith(TEXT_PREFIX)) {
        try {
          serialized = decodeBase64Url(plain.slice(TEXT_PREFIX.length));
        } catch {
          serialized = '';
        }
      }
    }
    if (!serialized) {
      const fileItem = Array.from(dataTransfer.items || []).find(
        (item) => item.kind === 'file' && String(item.type).toLowerCase() === MIME,
      );
      const file = fileItem?.getAsFile();
      if (file) serialized = await file.text();
    }
    const descriptor = JSON.parse(serialized || '{}');
    if (
      descriptor?.protocol !== 'kaoyan-material-v1'
      || typeof descriptor.transferId !== 'string'
      || typeof descriptor.relayUrl !== 'string'
    ) {
      throw new Error('拖拽数据不是有效的考研资料接力。');
    }
    const relayUrl = new URL(descriptor.relayUrl);
    if (!['http:', 'https:'].includes(relayUrl.protocol)) throw new Error('资料接力地址无效。');
    return {
      protocol: descriptor.protocol,
      transferId: descriptor.transferId,
      relayUrl: relayUrl.toString(),
      kind: ['image', 'pdf', 'word', 'html', 'file'].includes(descriptor.kind) ? descriptor.kind : 'file',
      name: String(descriptor.name || '未命名资料').slice(0, 240),
      mimeType: String(descriptor.mimeType || 'application/octet-stream').slice(0, 160),
    };
  };

  class PageWarpRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      });
      this.ready = false;
      this.program = null;
      this.uniforms = null;
      this.texture = null;
      if (this.gl) this.initialize();
    }

    initialize() {
      const gl = this.gl;
      const vertexSource = `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `;
      const fragmentSource = `
        precision highp float;
        varying vec2 v_uv;
        uniform sampler2D u_texture;
        uniform vec2 u_center;
        uniform vec2 u_resolution;
        uniform vec2 u_velocity;
        uniform float u_strength;
        uniform float u_impact;
        uniform float u_time;

        mat2 rotate2d(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat2(c, -s, s, c);
        }

        void main() {
          float aspect = u_resolution.x / max(u_resolution.y, 1.0);
          vec2 scale = vec2(aspect, 1.0);
          vec2 p = (v_uv - u_center) * scale;
          float radius = length(p);
          float influence = pow(max(0.0, 1.0 - smoothstep(0.035, 0.43, radius)), 2.25);
          vec2 direction = normalize(u_velocity + vec2(0.0001, 0.0));
          float along = dot(p, direction);
          float across = dot(p, vec2(-direction.y, direction.x));
          along *= 1.0 + influence * (0.10 * u_strength + 0.13 * abs(u_impact));
          across *= 1.0 - influence * (0.035 * u_strength);
          p = direction * along + vec2(-direction.y, direction.x) * across;
          float swirl = (0.095 * u_strength + 0.045 * u_impact)
            * influence
            * max(0.0, 1.0 - radius / 0.43);
          p = rotate2d(swirl) * p;
          p *= 1.0 + influence * (0.065 * u_strength + 0.105 * max(u_impact, 0.0));
          float waveFront = 0.03 + fract(u_time * 0.42) * 0.48;
          float wave = sin((radius - waveFront) * 54.0)
            * exp(-abs(radius - waveFront) * 24.0)
            * u_impact
            * 0.012;
          p += normalize(p + vec2(0.0001)) * wave;
          vec2 warped = u_center + p / scale;
          float chroma = influence * u_strength * 0.0019;
          vec2 chromaOffset = normalize(p + vec2(0.0001)) * chroma;
          float red = texture2D(u_texture, warped + chromaOffset).r;
          float green = texture2D(u_texture, warped).g;
          float blue = texture2D(u_texture, warped - chromaOffset).b;
          float shade = 1.0 - influence * u_strength * 0.035;
          gl_FragColor = vec4(vec3(red, green, blue) * shade, 1.0);
        }
      `;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed');
        }
        return shader;
      };
      try {
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(program) || 'WebGL program linking failed');
        }
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 1, -1, -1, 1,
          -1, 1, 1, -1, 1, 1,
        ]), gl.STATIC_DRAW);
        gl.useProgram(program);
        const position = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        this.program = program;
        this.uniforms = {
          center: gl.getUniformLocation(program, 'u_center'),
          resolution: gl.getUniformLocation(program, 'u_resolution'),
          velocity: gl.getUniformLocation(program, 'u_velocity'),
          strength: gl.getUniformLocation(program, 'u_strength'),
          impact: gl.getUniformLocation(program, 'u_impact'),
          time: gl.getUniformLocation(program, 'u_time'),
        };
      } catch (error) {
        console.warn('[kaoyan-relay] WebGL unavailable', error);
        this.gl = null;
      }
    }

    async setImage(dataUrl) {
      if (!this.gl || !dataUrl) return false;
      const image = new Image();
      image.decoding = 'async';
      image.src = dataUrl;
      await image.decode();
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      if (this.texture) gl.deleteTexture(this.texture);
      this.texture = texture;
      this.ready = true;
      return true;
    }

    resize() {
      if (!this.gl) return;
      const scale = Math.min(devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(innerWidth * scale));
      const height = Math.max(1, Math.round(innerHeight * scale));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.gl.viewport(0, 0, width, height);
    }

    draw(center, velocity, strength, impact, elapsed) {
      if (!this.ready || !this.gl) return false;
      this.resize();
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform2f(this.uniforms.center, center.x / innerWidth, 1 - center.y / innerHeight);
      gl.uniform2f(this.uniforms.resolution, innerWidth, innerHeight);
      gl.uniform2f(this.uniforms.velocity, velocity.x, -velocity.y);
      gl.uniform1f(this.uniforms.strength, strength);
      gl.uniform1f(this.uniforms.impact, impact);
      gl.uniform1f(this.uniforms.time, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return true;
    }

    destroy() {
      if (!this.gl) return;
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.program) this.gl.deleteProgram(this.program);
      this.ready = false;
    }
  }

  const styleText = `
    :host { all: initial; color-scheme: light; }
    * { box-sizing: border-box; }
    .relay-shell {
      position: fixed;
      z-index: 2147483646;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
      transition: opacity 90ms linear;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .relay-shell.is-active { opacity: 1; }
    .relay-warp {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      transition: opacity 90ms linear;
    }
    .relay-shell.has-capture .relay-warp { opacity: 1; }
    .relay-glass {
      position: absolute;
      inset: 0;
      opacity: 1;
      background:
        radial-gradient(circle at var(--relay-x, 50%) var(--relay-y, 50%),
          rgba(255,255,255,.26) 0 4%,
          rgba(157,129,99,.14) 9%,
          rgba(36,30,25,.07) 22%,
          transparent 46%),
        rgba(38,31,25,.025);
      backdrop-filter: saturate(.94) brightness(.985);
      transition: opacity 120ms linear;
    }
    .relay-shell.has-capture .relay-glass { opacity: .28; }
    .relay-portal {
      position: absolute;
      left: 0;
      top: 0;
      width: calc(142px + var(--relay-strength, 0) * 76px);
      height: calc(142px + var(--relay-strength, 0) * 76px);
      border: 1px solid rgba(116,87,61,.25);
      border-radius: 50%;
      background:
        radial-gradient(circle,
          rgba(255,255,255,.74) 0 7%,
          rgba(232,220,205,.2) 24%,
          rgba(137,105,76,.13) 42%,
          transparent 68%);
      box-shadow:
        inset 0 0 28px rgba(255,255,255,.52),
        0 0 52px rgba(95,70,47,.12);
      transform: translate(-50%, -50%) scale(calc(.76 + var(--relay-strength, 0) * .25));
      transition: width 80ms linear, height 80ms linear;
    }
    .relay-portal::after {
      content: "";
      position: absolute;
      inset: 18%;
      border: 1px solid rgba(118,89,61,.18);
      border-radius: inherit;
      transform: rotate(18deg);
    }
    .relay-ghost {
      position: absolute;
      left: 0;
      top: 0;
      max-width: min(300px, 52vw);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      overflow: hidden;
      color: #4b4138;
      border: 1px solid rgba(126,94,66,.22);
      border-radius: 11px;
      background: rgba(255,253,249,.92);
      box-shadow: 0 15px 38px rgba(32,26,21,.18);
      backdrop-filter: blur(14px);
      transform: translate(14px, -50%) rotate(var(--relay-tilt, 0deg));
      white-space: nowrap;
    }
    .relay-ghost b {
      flex: none;
      padding: 5px 7px;
      color: #775333;
      border-radius: 6px;
      background: #eee8e0;
      font-size: 10px;
    }
    .relay-ghost span {
      overflow: hidden;
      font-size: 12px;
      font-weight: 650;
      text-overflow: ellipsis;
    }
    .relay-status {
      position: absolute;
      left: 50%;
      bottom: 28px;
      padding: 8px 12px;
      color: #54493f;
      border: 1px solid rgba(100,78,58,.14);
      border-radius: 999px;
      background: rgba(255,253,249,.9);
      box-shadow: 0 9px 24px rgba(36,29,23,.12);
      backdrop-filter: blur(12px);
      transform: translateX(-50%);
      font-size: 11px;
      font-weight: 650;
    }
    .relay-shell.is-armed .relay-status {
      color: #704b29;
      border-color: rgba(132,87,47,.28);
    }
    .relay-material {
      position: fixed;
      z-index: 4;
      width: min(560px, calc(100vw - 32px));
      height: min(430px, calc(100vh - 74px));
      overflow: hidden;
      pointer-events: auto;
      border: 1px solid rgba(78,64,51,.18);
      border-radius: 16px;
      background: #fbfaf7;
      box-shadow: 0 24px 70px rgba(30,25,21,.28);
      transform-origin: 50% 50%;
      animation: relay-land 650ms cubic-bezier(.18,.78,.2,1) both;
    }
    .relay-material.is-image { width: min(660px, calc(100vw - 32px)); height: min(520px, calc(100vh - 74px)); }
    .relay-material > header {
      height: 34px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 6px 0 11px;
      color: #4d453e;
      border-bottom: 1px solid #e5dfd7;
      background: rgba(255,255,255,.92);
      cursor: grab;
      user-select: none;
    }
    .relay-material > header strong {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .relay-material > header button {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      padding: 0;
      color: #6f665e;
      border: 0;
      border-radius: 7px;
      background: transparent;
      cursor: pointer;
      font: 14px/1 sans-serif;
    }
    .relay-material > header button:hover { background: #eeeae4; }
    .relay-material-body {
      width: 100%;
      height: calc(100% - 34px);
      display: grid;
      place-items: center;
      overflow: auto;
      background: #f5f3ef;
    }
    .relay-material-body img {
      display: block;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .relay-material-body iframe,
    .relay-material-body embed {
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }
    .relay-file-fallback {
      max-width: 360px;
      display: grid;
      justify-items: center;
      gap: 11px;
      padding: 28px;
      color: #574d44;
      text-align: center;
    }
    .relay-file-fallback b {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      color: #795536;
      border-radius: 14px;
      background: #eae3da;
      font-size: 13px;
    }
    .relay-file-fallback strong { font-size: 13px; overflow-wrap: anywhere; }
    @keyframes relay-land {
      0% { opacity: .16; transform: translateY(20px) scale(.58); filter: blur(5px); }
      31% { opacity: 1; transform: translateY(-8px) scale(1.12); filter: blur(0); }
      55% { transform: translateY(4px) scale(.95); }
      78% { transform: translateY(-2px) scale(1.035); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .relay-shell, .relay-warp, .relay-glass { transition-duration: .01ms !important; }
      .relay-material { animation: relay-fade 120ms ease-out both; }
      @keyframes relay-fade { from { opacity: 0; } to { opacity: 1; } }
    }
  `;

  let ui = null;
  let renderer = null;
  let animationFrame = 0;
  let cancelTimer = 0;
  let sourceDragTimer = 0;
  let sourceDragActive = false;
  let activeCards = 0;
  const state = {
    mode: 'idle',
    pointer: { x: innerWidth / 2, y: innerHeight / 2 },
    previousPointer: { x: innerWidth / 2, y: innerHeight / 2 },
    center: { x: innerWidth / 2, y: innerHeight / 2 },
    centerVelocity: { x: 0, y: 0 },
    pointerVelocity: { x: 1, y: 0 },
    strength: 0,
    startedAt: 0,
    lastAt: 0,
    lastDragAt: 0,
    armedAt: 0,
    droppedAt: 0,
    pendingDescriptor: null,
  };

  const ensureUi = () => {
    if (ui) return ui;
    const host = document.createElement('div');
    host.setAttribute('data-kaoyan-drag-relay', '');
    host.dataset.relayState = 'idle';
    host.dataset.captureState = 'idle';
    host.dataset.cardCount = '0';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styleText;
    const shell = document.createElement('div');
    shell.className = 'relay-shell';
    shell.innerHTML = `
      <canvas class="relay-warp"></canvas>
      <div class="relay-glass"></div>
      <div class="relay-portal"></div>
      <div class="relay-ghost"><b>资料</b><span>释放后接力到这里</span></div>
      <div class="relay-status">已识别资料，拖入页面后松手</div>
    `;
    shadow.append(style, shell);
    (document.documentElement || document).append(host);
    const canvas = shell.querySelector('.relay-warp');
    renderer = new PageWarpRenderer(canvas);
    ui = {
      host,
      shadow,
      shell,
      canvas,
      portal: shell.querySelector('.relay-portal'),
      ghost: shell.querySelector('.relay-ghost'),
      ghostType: shell.querySelector('.relay-ghost b'),
      ghostName: shell.querySelector('.relay-ghost span'),
      status: shell.querySelector('.relay-status'),
    };
    return ui;
  };

  const entryCenter = (x, y) => {
    const distances = [
      ['left', x],
      ['right', innerWidth - x],
      ['top', y],
      ['bottom', innerHeight - y],
    ].sort((left, right) => left[1] - right[1]);
    const edge = distances[0][0];
    if (edge === 'left') return { x: 120, y: clamp(y, 90, innerHeight - 90) };
    if (edge === 'right') return { x: innerWidth - 120, y: clamp(y, 90, innerHeight - 90) };
    if (edge === 'top') return { x: clamp(x, 110, innerWidth - 110), y: 104 };
    return { x: clamp(x, 110, innerWidth - 110), y: innerHeight - 104 };
  };

  const capturePage = async () => {
    const currentUi = ensureUi();
    currentUi.host.dataset.captureState = 'pending';
    currentUi.shell.style.visibility = 'hidden';
    await nextFrame();
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGE.capture });
      if (response?.ok && response.dataUrl && renderer) {
        await renderer.setImage(response.dataUrl);
        currentUi.shell.classList.add('has-capture');
        currentUi.host.dataset.captureState = 'ready';
      }
    } catch (error) {
      currentUi.host.dataset.captureState = 'fallback';
      console.warn('[kaoyan-relay] page capture fallback', error);
    } finally {
      currentUi.shell.style.visibility = '';
    }
  };

  const updatePointer = (event) => {
    const now = performance.now();
    const elapsed = Math.max(8, now - (state.lastAt || now));
    state.previousPointer = { ...state.pointer };
    state.pointer = { x: event.clientX, y: event.clientY };
    state.pointerVelocity.x = mix(
      state.pointerVelocity.x,
      (state.pointer.x - state.previousPointer.x) / elapsed,
      0.38,
    );
    state.pointerVelocity.y = mix(
      state.pointerVelocity.y,
      (state.pointer.y - state.previousPointer.y) / elapsed,
      0.38,
    );
    state.lastAt = now;
    state.lastDragAt = now;
  };

  const startTracking = (event) => {
    const currentUi = ensureUi();
    updatePointer(event);
    const start = entryCenter(event.clientX, event.clientY);
    state.mode = 'tracking';
    state.center = start;
    state.centerVelocity = { x: 0, y: 0 };
    state.strength = 0.12;
    state.startedAt = performance.now();
    state.armedAt = 0;
    currentUi.host.dataset.relayState = 'tracking';
    currentUi.shell.classList.add('is-active');
    currentUi.shell.classList.remove('is-armed', 'is-dropping');
    currentUi.status.textContent = '已识别资料，拖入页面后松手';
    void capturePage();
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
  };

  const resetTracking = (keepCards = true) => {
    clearTimeout(cancelTimer);
    state.mode = 'idle';
    state.strength = 0;
    state.armedAt = 0;
    state.pendingDescriptor = null;
    if (ui) {
      ui.host.dataset.relayState = 'idle';
      ui.shell.classList.remove('is-active', 'is-armed', 'is-dropping', 'has-capture');
      ui.shell.style.removeProperty('--relay-strength');
    }
    if (!keepCards || activeCards === 0) {
      renderer?.destroy();
      renderer = null;
      ui?.host.remove();
      ui = null;
    }
  };

  const impactSignal = (elapsed) => {
    if (elapsed < 0.15) return smoothstep(0, 0.15, elapsed);
    const tail = elapsed - 0.15;
    return Math.exp(-tail * 4.8) * Math.cos(tail * 29);
  };

  const tick = (now) => {
    animationFrame = 0;
    if (state.mode === 'idle') return;
    const elapsed = Math.min(0.034, Math.max(0.001, (now - (state.lastAt || now)) / 1000));
    const desired = {
      x: mix(state.center.x, state.pointer.x, 0.64),
      y: mix(state.center.y, state.pointer.y, 0.64),
    };
    const stiffness = state.mode === 'dropping' ? 250 : 155;
    const damping = state.mode === 'dropping' ? 21 : 18;
    state.centerVelocity.x += (
      stiffness * (desired.x - state.center.x) - damping * state.centerVelocity.x
    ) * elapsed;
    state.centerVelocity.y += (
      stiffness * (desired.y - state.center.y) - damping * state.centerVelocity.y
    ) * elapsed;
    state.center.x += state.centerVelocity.x * elapsed;
    state.center.y += state.centerVelocity.y * elapsed;

    const distance = Math.hypot(state.pointer.x - state.center.x, state.pointer.y - state.center.y);
    const desiredStrength = state.mode === 'dropping'
      ? 1
      : 0.22 + (1 - smoothstep(65, 270, distance)) * 0.72;
    state.strength = mix(state.strength, desiredStrength, reducedMotion.matches ? 0.8 : 0.16);
    if (state.mode === 'tracking') {
      if (distance < 118) {
        if (!state.armedAt) state.armedAt = now;
        if (now - state.armedAt > 90) state.mode = 'armed';
      } else if (distance > 184) {
        state.armedAt = 0;
      }
    } else if (state.mode === 'armed' && distance > 184) {
      state.mode = 'tracking';
      state.armedAt = 0;
    }

    const currentUi = ensureUi();
    currentUi.shell.classList.toggle('is-armed', state.mode === 'armed');
    currentUi.host.dataset.relayState = state.mode;
    currentUi.portal.style.left = `${state.center.x}px`;
    currentUi.portal.style.top = `${state.center.y}px`;
    currentUi.ghost.style.left = `${state.pointer.x}px`;
    currentUi.ghost.style.top = `${state.pointer.y}px`;
    const tilt = clamp(state.pointerVelocity.x * 5.5, -5, 5);
    currentUi.ghost.style.setProperty('--relay-tilt', `${tilt}deg`);
    currentUi.shell.style.setProperty('--relay-x', `${(state.center.x / innerWidth) * 100}%`);
    currentUi.shell.style.setProperty('--relay-y', `${(state.center.y / innerHeight) * 100}%`);
    currentUi.shell.style.setProperty('--relay-strength', String(state.strength));
    currentUi.status.textContent = state.mode === 'armed'
      ? '已吸附，松手接力资料'
      : state.mode === 'dropping'
        ? '正在接力资料…'
        : '已识别资料，拖入页面后松手';
    const dragMagnitude = Math.hypot(state.pointerVelocity.x, state.pointerVelocity.y);
    const normalizedVelocity = dragMagnitude > 0.001
      ? { x: state.pointerVelocity.x / dragMagnitude, y: state.pointerVelocity.y / dragMagnitude }
      : { x: 1, y: 0 };
    const dropElapsed = state.mode === 'dropping' ? (now - state.droppedAt) / 1000 : 0;
    const impact = state.mode === 'dropping' && !reducedMotion.matches ? impactSignal(dropElapsed) : 0;
    renderer?.draw(
      state.center,
      normalizedVelocity,
      reducedMotion.matches ? Math.min(state.strength, 0.16) : state.strength,
      impact,
      (now - state.startedAt) / 1000,
    );
    if (state.mode !== 'idle') animationFrame = requestAnimationFrame(tick);
  };

  const sendOpen = (url) => {
    if (url) void chrome.runtime.sendMessage({ type: MESSAGE.open, url });
  };

  const makeMovable = (card, header) => {
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
      const move = (next) => {
        const left = clamp(start.left + next.clientX - start.x, 8, innerWidth - card.offsetWidth - 8);
        const top = clamp(start.top + next.clientY - start.y, 8, innerHeight - card.offsetHeight - 8);
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
      };
      const end = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', end);
        header.removeEventListener('pointercancel', end);
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', end);
      header.addEventListener('pointercancel', end);
    });
  };

  const createMaterialCard = (asset, landingPoint) => {
    const currentUi = ensureUi();
    const card = document.createElement('section');
    card.className = `relay-material is-${asset.kind || 'file'}`;
    const width = asset.kind === 'image' ? 660 : 560;
    const height = asset.kind === 'image' ? 520 : 430;
    card.style.left = `${clamp(landingPoint.x - width / 2, 16, Math.max(16, innerWidth - width - 16))}px`;
    card.style.top = `${clamp(landingPoint.y - 40, 42, Math.max(42, innerHeight - height - 16))}px`;
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = asset.name || '未命名资料';
    const open = document.createElement('button');
    open.type = 'button';
    open.title = '在新标签页打开';
    open.textContent = '↗';
    open.addEventListener('click', () => sendOpen(asset.url || asset.fallbackUrl));
    const close = document.createElement('button');
    close.type = 'button';
    close.title = '关闭资料';
    close.textContent = '×';
    header.append(title, open, close);
    const body = document.createElement('div');
    body.className = 'relay-material-body';
    const primaryUrl = asset.url || asset.fallbackUrl;
    if (asset.kind === 'image') {
      const image = document.createElement('img');
      image.alt = asset.name || '';
      image.src = asset.posterUrl || primaryUrl;
      if (asset.fallbackUrl) image.addEventListener('error', () => { image.src = asset.fallbackUrl; }, { once: true });
      body.append(image);
    } else if (asset.kind === 'pdf') {
      const embed = document.createElement('embed');
      embed.type = 'application/pdf';
      embed.src = `${primaryUrl}#toolbar=1&navpanes=0`;
      body.append(embed);
    } else if (asset.kind === 'html') {
      const frame = document.createElement('iframe');
      frame.title = asset.name || 'HTML 资料';
      frame.setAttribute('sandbox', 'allow-scripts allow-forms');
      frame.src = primaryUrl;
      body.append(frame);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'relay-file-fallback';
      fallback.innerHTML = `<b>${asset.kind === 'word' ? 'DOC' : 'FILE'}</b><strong></strong><span>已完成接力，可点击右上角在新标签页打开。</span>`;
      fallback.querySelector('strong').textContent = asset.name || '未命名资料';
      body.append(fallback);
    }
    card.append(header, body);
    currentUi.shadow.append(card);
    activeCards += 1;
    currentUi.host.dataset.cardCount = String(activeCards);
    close.addEventListener('click', () => {
      card.remove();
      activeCards = Math.max(0, activeCards - 1);
      currentUi.host.dataset.cardCount = String(activeCards);
      if (activeCards === 0 && state.mode === 'idle') resetTracking(false);
    });
    makeMovable(card, header);
  };

  const resolveAndLand = async (descriptor, landingPoint) => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE.resolve,
        url: descriptor.relayUrl,
      });
      if (!response?.ok || !response.result?.asset) {
        throw new Error(response?.error || '资料接力解析失败。');
      }
      createMaterialCard(response.result.asset, landingPoint);
      if (ui) {
        ui.ghost.style.opacity = '0';
        ui.status.textContent = '资料已接力';
      }
    } catch (error) {
      if (ui) {
        ui.status.textContent = error?.message || '资料接力失败';
        ui.shell.classList.remove('is-dropping');
      }
    }
  };

  document.addEventListener('dragstart', (event) => {
    if (!recognizesRelay(event.dataTransfer)) return;
    sourceDragActive = true;
    clearTimeout(sourceDragTimer);
    sourceDragTimer = setTimeout(() => {
      sourceDragActive = false;
    }, 15_000);
    if (state.mode !== 'idle') resetTracking();
  }, false);

  document.addEventListener('dragend', () => {
    clearTimeout(sourceDragTimer);
    sourceDragActive = false;
  }, true);

  document.addEventListener('dragenter', (event) => {
    if (sourceDragActive || !recognizesRelay(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.mode === 'idle') startTracking(event);
    else updatePointer(event);
  }, true);

  document.addEventListener('dragover', (event) => {
    if (sourceDragActive || !recognizesRelay(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (state.mode === 'idle') startTracking(event);
    else updatePointer(event);
  }, true);

  document.addEventListener('dragleave', (event) => {
    if (state.mode === 'idle' || state.mode === 'dropping') return;
    const outside = event.clientX <= 0
      || event.clientY <= 0
      || event.clientX >= innerWidth - 1
      || event.clientY >= innerHeight - 1;
    if (!outside) return;
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      if (performance.now() - state.lastDragAt > 110) resetTracking();
    }, 130);
  }, true);

  document.addEventListener('drop', (event) => {
    if (sourceDragActive || !recognizesRelay(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(cancelTimer);
    updatePointer(event);
    state.mode = 'dropping';
    ensureUi().host.dataset.relayState = 'dropping';
    state.droppedAt = performance.now();
    ensureUi().shell.classList.add('is-dropping');
    void parseDescriptor(event.dataTransfer).then((descriptor) => {
      state.pendingDescriptor = descriptor;
      if (ui) {
        ui.ghostType.textContent = descriptor.kind === 'image' ? 'IMG' : descriptor.kind === 'word' ? 'DOC' : descriptor.kind.toUpperCase();
        ui.ghostName.textContent = descriptor.name;
      }
      return resolveAndLand(descriptor, { ...state.center });
    }).catch((error) => {
      if (ui) ui.status.textContent = error?.message || '无法读取资料接力信息';
    });
    setTimeout(() => {
      state.mode = 'idle';
      if (ui) {
        ui.host.dataset.relayState = 'idle';
        ui.shell.classList.remove('is-active', 'is-armed', 'is-dropping', 'has-capture');
        ui.ghost.style.opacity = '';
      }
      if (activeCards === 0) resetTracking(false);
    }, reducedMotion.matches ? 160 : 790);
  }, true);

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.mode !== 'idle') resetTracking();
  }, true);

  addEventListener('resize', () => {
    state.pointer.x = clamp(state.pointer.x, 0, innerWidth);
    state.pointer.y = clamp(state.pointer.y, 0, innerHeight);
    state.center.x = clamp(state.center.x, 0, innerWidth);
    state.center.y = clamp(state.center.y, 0, innerHeight);
    renderer?.resize();
  });

  setInterval(() => {
    if (
      state.mode !== 'idle'
      && state.mode !== 'dropping'
      && performance.now() - state.lastDragAt > 650
    ) {
      resetTracking();
    }
  }, 250);
})();
