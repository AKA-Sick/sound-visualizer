import { themes } from './themes.js';

export class Mirrored {
  draw(ctx, canvas, bars, settings, beat) {
    const theme = themes[settings.theme];
    const color = theme.mirror;
    const barCount = bars.length;
    const totalBarWidth = canvas.width / barCount;
    const barWidth = Math.max(1, totalBarWidth * 0.7);
    const centerY = canvas.height / 2;
    const maxBarHeight = centerY * 0.9;

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + (totalBarWidth - barWidth) / 2;
      const value = Math.min(1, bars[i]);
      const barHeight = value * maxBarHeight;

      if (barHeight < 1) continue;

      // Top half (full opacity)
      ctx.fillStyle = color;
      ctx.globalAlpha = 1.0;
      ctx.fillRect(x, centerY - barHeight, barWidth, barHeight);

      // Bottom half (reflection, faded)
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x, centerY, barWidth, barHeight);
    }

    ctx.globalAlpha = 1.0;
  }
}
