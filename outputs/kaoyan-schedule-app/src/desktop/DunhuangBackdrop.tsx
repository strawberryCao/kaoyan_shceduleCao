import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  drift: number;
};

const PARTICLE_COUNT = 92;

const createParticle = (width: number, height: number): Particle => ({
  x: Math.random() * width,
  y: Math.random() * height,
  vx: 0.06 + Math.random() * 0.16,
  vy: -0.015 + Math.random() * 0.035,
  size: 0.55 + Math.random() * 1.75,
  alpha: 0.08 + Math.random() * 0.22,
  drift: Math.random() * Math.PI * 2,
});

export function DunhuangBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, active: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return;
    }

    let frame = 0;
    let raf = 0;
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle(width, height));
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = {
        x: event.clientX / Math.max(1, width),
        y: event.clientY / Math.max(1, height),
        active: true,
      };
      document.documentElement.style.setProperty('--dh-x', `${(pointerRef.current.x - 0.5) * 26}px`);
      document.documentElement.style.setProperty('--dh-y', `${(pointerRef.current.y - 0.5) * 18}px`);
    };

    const draw = () => {
      frame += 1;
      const time = frame / 60;
      context.clearRect(0, 0, width, height);

      const pointer = pointerRef.current;
      const windX = (pointer.x - 0.5) * 0.34;
      const windY = (pointer.y - 0.5) * 0.11;

      context.save();
      context.globalCompositeOperation = 'screen';
      for (const particle of particles) {
        particle.drift += 0.006;
        particle.x += particle.vx + windX * 0.16 + Math.sin(particle.drift + time * 0.38) * 0.055;
        particle.y += particle.vy + windY * 0.07 + Math.cos(particle.drift * 0.7 + time * 0.26) * 0.028;

        if (particle.x > width + 20) particle.x = -20;
        if (particle.x < -24) particle.x = width + 20;
        if (particle.y > height + 20) particle.y = -20;
        if (particle.y < -24) particle.y = height + 20;

        const glow = particle.size * (1 + Math.sin(time * 0.75 + particle.drift) * 0.18);
        context.beginPath();
        context.fillStyle = `rgba(255, 220, 156, ${particle.alpha})`;
        context.arc(particle.x, particle.y, glow, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      raf = window.requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, []);

  return (
    <div className="dh-backdrop" aria-hidden="true">
      <div className="dh-sandscape" />
      <div className="dh-paper-grain" />
      <div className="dh-silk dh-silk-one" />
      <div className="dh-silk dh-silk-two" />
      <div className="dh-silk dh-silk-three" />
      <div className="dh-light-orb" />
      <canvas ref={canvasRef} className="dh-particle-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
