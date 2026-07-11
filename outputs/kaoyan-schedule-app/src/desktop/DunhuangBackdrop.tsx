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
};

const MAX_DUST = 70;

const createDust = (x: number, y: number, windX: number, windY: number): DustParticle => {
  const angle = Math.atan2(windY, windX) + (Math.random() - 0.5) * 0.9;
  const speed = 0.28 + Math.random() * 0.82;
  return {
    x: x + (Math.random() - 0.5) * 18,
    y: y + (Math.random() - 0.5) * 14,
    vx: Math.cos(angle) * speed + windX * 0.026,
    vy: Math.sin(angle) * speed + windY * 0.026 - Math.random() * 0.16,
    size: 0.38 + Math.random() * 0.95,
    alpha: 0.028 + Math.random() * 0.055,
    life: 0,
    maxLife: 70 + Math.random() * 55,
  };
};

export function DunhuangBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0, y: 0, px: 0, py: 0, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return;
    }

    let animationId = 0;
    let width = 1;
    let height = 1;
    const particles: DustParticle[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      const windX = event.clientX - pointer.x;
      const windY = event.clientY - pointer.y;
      const speed = Math.hypot(windX, windY);
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;

      document.documentElement.style.setProperty('--dh-x', `${(event.clientX / Math.max(1, width) - 0.5) * 8}px`);
      document.documentElement.style.setProperty('--dh-y', `${(event.clientY / Math.max(1, height) - 0.5) * 6}px`);

      if (speed > 10) {
        const count = Math.min(5, Math.floor(speed / 30) + 1);
        for (let index = 0; index < count; index += 1) {
          if (particles.length >= MAX_DUST) {
            particles.shift();
          }
          particles.push(createDust(event.clientX, event.clientY, windX, windY));
        }
      }
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.save();
      context.globalCompositeOperation = 'source-over';

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += 1;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vx *= 0.986;
        particle.vy = particle.vy * 0.984 - 0.0015;

        const t = particle.life / particle.maxLife;
        const alpha = particle.alpha * (1 - t) * (0.45 + 0.55 * Math.sin(t * Math.PI));
        if (t >= 1 || alpha <= 0.0015) {
          particles.splice(index, 1);
          continue;
        }

        const radius = particle.size * (1 + t * 1.15);
        const glowRadius = radius * 2.25;
        const gradient = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
        gradient.addColorStop(0, `rgba(229, 194, 133, ${alpha})`);
        gradient.addColorStop(0.55, `rgba(197, 146, 82, ${alpha * 0.22})`);
        gradient.addColorStop(1, 'rgba(197, 146, 82, 0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
        context.fill();
      }

      context.restore();
      animationId = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  return (
    <div className="dh-backdrop" aria-hidden="true">
      <div className={`dh-image-fallback ${videoReady ? 'is-hidden' : ''}`} />
      {!videoFailed && (
        <video
          className={`dh-video-bg ${videoReady ? 'is-ready' : ''}`}
          src="/dunhuang-loop.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onCanPlay={() => setVideoReady(true)}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
          }}
        />
      )}
      <canvas ref={canvasRef} className="dh-interaction-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
