import { useEffect, useRef, useState } from 'react';

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  stretch: number;
  angle: number;
};

type PointerState = {
  x: number;
  y: number;
  active: boolean;
};

const MAX_DUST = 260;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const createPointerDust = (x: number, y: number, windX: number, windY: number): DustParticle => {
  const angle = Math.atan2(windY, windX) + (Math.random() - 0.5) * 1.25;
  const speed = 0.7 + Math.random() * 2.1;
  return {
    x: x + (Math.random() - 0.5) * 34,
    y: y + (Math.random() - 0.5) * 22,
    vx: Math.cos(angle) * speed + windX * 0.036,
    vy: Math.sin(angle) * speed + windY * 0.026 - 0.35 - Math.random() * 0.38,
    size: 0.9 + Math.random() * 2.2,
    alpha: 0.13 + Math.random() * 0.18,
    life: 0,
    maxLife: 70 + Math.random() * 72,
    stretch: 1.15 + Math.random() * 1.6,
    angle,
  };
};

const createAmbientDust = (width: number, height: number): DustParticle => ({
  x: -24 + Math.random() * (width + 48),
  y: height * (0.48 + Math.random() * 0.5),
  vx: 0.18 + Math.random() * 0.5,
  vy: -0.07 - Math.random() * 0.22,
  size: 0.6 + Math.random() * 1.45,
  alpha: 0.045 + Math.random() * 0.075,
  life: 0,
  maxLife: 210 + Math.random() * 240,
  stretch: 1 + Math.random() * 0.7,
  angle: -0.22 + Math.random() * 0.25,
});

const silkInfluenceAt = (nx: number, ny: number) => {
  const upperRight = clamp((nx - 0.55) / 0.38, 0, 1) * clamp((0.76 - ny) / 0.48, 0, 1);
  const lowerBand = clamp((ny - 0.58) / 0.34, 0, 1) * clamp((nx + 0.06) / 0.62, 0, 1);
  return clamp(Math.max(upperRight, lowerBand), 0, 1);
};

export function DunhuangBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>({ x: 0, y: 0, active: false });

  useEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    const canvas = dustCanvasRef.current;
    if (!root || !video || !canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return;
    }

    let animationId = 0;
    let width = 1;
    let height = 1;
    let lastAmbientAt = 0;
    let silkX = 0;
    let silkY = 0;
    let silkEnergy = 0;
    const particles: DustParticle[] = [];

    const updateSilkVariables = () => {
      root.style.setProperty('--dh-silk-x', `${silkX.toFixed(2)}px`);
      root.style.setProperty('--dh-silk-y', `${silkY.toFixed(2)}px`);
      root.style.setProperty('--dh-silk-energy', silkEnergy.toFixed(3));
    };

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onMouseMove = (event: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointerRef.current.active = false;
        return;
      }

      const pointer = pointerRef.current;
      if (!pointer.active) {
        pointer.x = x;
        pointer.y = y;
        pointer.active = true;
        return;
      }

      const windX = x - pointer.x;
      const windY = y - pointer.y;
      const speed = Math.hypot(windX, windY);
      pointer.x = x;
      pointer.y = y;

      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest('.desktop-widget, .desktop-console-sidebar, .desktop-control-dock'));
      if (!overUi && speed > 0.8) {
        const count = Math.min(20, Math.max(4, Math.floor(speed / 5)));
        for (let index = 0; index < count; index += 1) {
          if (particles.length >= MAX_DUST) {
            particles.shift();
          }
          particles.push(createPointerDust(x, y, windX, windY));
        }
      }

      const nx = clamp(x / Math.max(width, 1), 0, 1);
      const ny = clamp(y / Math.max(height, 1), 0, 1);
      const influence = silkInfluenceAt(nx, ny);
      if (influence > 0.02) {
        silkX = clamp(silkX + windX * 0.025 * influence, -5.5, 5.5);
        silkY = clamp(silkY + windY * 0.018 * influence, -3.8, 3.8);
        silkEnergy = Math.max(silkEnergy, clamp(speed / 34, 0.08, 1) * influence);
        video.playbackRate = 0.92 + silkEnergy * 0.16;
      }
    };

    const onMouseLeave = () => {
      pointerRef.current.active = false;
    };

    const drawParticle = (particle: DustParticle, alpha: number, radius: number) => {
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);

      const haze = context.createRadialGradient(0, 0, 0, 0, 0, radius * 3.4);
      haze.addColorStop(0, `rgba(142, 96, 48, ${alpha * 0.42})`);
      haze.addColorStop(0.45, `rgba(157, 112, 63, ${alpha * 0.16})`);
      haze.addColorStop(1, 'rgba(167, 124, 72, 0)');
      context.fillStyle = haze;
      context.beginPath();
      context.ellipse(0, 0, radius * particle.stretch * 3.4, radius * 3.4, 0, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = `rgba(116, 76, 38, ${alpha})`;
      context.beginPath();
      context.ellipse(0, 0, radius * particle.stretch, radius, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'multiply';

      if (now - lastAmbientAt > 72 && particles.length < 145) {
        particles.push(createAmbientDust(width, height));
        lastAmbientAt = now;
      }

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += 1;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vx *= 0.989;
        particle.vy = particle.vy * 0.987 - 0.0012;

        const t = particle.life / particle.maxLife;
        const fadeIn = Math.min(1, t * 5.5);
        const alpha = particle.alpha * fadeIn * Math.pow(Math.max(0, 1 - t), 1.25);
        if (t >= 1 || alpha <= 0.001) {
          particles.splice(index, 1);
          continue;
        }

        const radius = Math.max(0.45, particle.size * (1 + t * 0.5));
        drawParticle(particle, alpha, radius);
      }

      silkX *= 0.91;
      silkY *= 0.91;
      silkEnergy *= 0.9;
      if (silkEnergy < 0.008) {
        silkEnergy = 0;
        video.playbackRate += (0.92 - video.playbackRate) * 0.08;
      }
      updateSilkVariables();
      animationId = window.requestAnimationFrame(draw);
    };

    resize();
    updateSilkVariables();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    animationId = window.requestAnimationFrame(draw);
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('blur', onMouseLeave);

    return () => {
      window.cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('blur', onMouseLeave);
    };
  }, []);

  const handleVideoReady = () => {
    setVideoReady(true);
    setVideoFailed(false);
    if (videoRef.current) {
      videoRef.current.playbackRate = 0.92;
      void videoRef.current.play().catch(() => undefined);
    }
  };

  return (
    <div ref={rootRef} className="dh-backdrop" aria-hidden="true">
      <div className={`dh-image-fallback ${videoReady ? 'is-hidden' : ''}`} />
      {!videoFailed && (
        <video
          ref={videoRef}
          className={`dh-video-bg ${videoReady ? 'is-ready' : ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/dunhuang-wallpaper.png"
          disablePictureInPicture
          onCanPlay={handleVideoReady}
          onLoadedData={handleVideoReady}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
          }}
        >
          <source src="/dunhuang-loop.mp4" type="video/mp4" />
        </video>
      )}
      <div className="dh-halo-neutralizer" />
      <div className="dh-silk-glint dh-silk-glint-upper" />
      <div className="dh-silk-glint dh-silk-glint-lower" />
      <canvas ref={dustCanvasRef} className="dh-interaction-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
