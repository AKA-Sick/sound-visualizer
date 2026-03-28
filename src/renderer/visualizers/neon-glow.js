import { themes } from './themes.js';

export class NeonGlow {
  draw(ctx, canvas, bars, settings, beat) {
    const theme = themes[settings.theme];
    const colors = theme.gradient;
    const barCount = bars.length;
    const totalBarWidth = canvas.width / barCount;
    const barWidth = Math.max(1, totalBarWidth * 0.7);

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + (totalBarWidth - barWidth) / 2;
      const value = Math.min(1, bars[i]);
      const barHeight = value * canvas.height * 0.9;

      if (barHeight < 1) continue;

      const ratio = i / barCount;
      const colorIndex = Math.min(colors.length - 1, Math.floor(ratio * colors.length));
      const color = colors[colorIndex];

      ctx.shadowBlur = 15;
      ctx.shadowColor = color;

      ctx.fillStyle = color;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
}
