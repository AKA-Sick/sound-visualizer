import { themes } from './themes.js';

export class SegmentedLED {
  constructor() {
    this.segmentHeight = 4;
    this.segmentGap = 2;
    this.maxSegments = 30;
  }

  draw(ctx, canvas, bars, settings, beat) {
    const theme = themes[settings.theme];
    const barCount = bars.length;
    const totalBarWidth = canvas.width / barCount;
    const barWidth = Math.max(1, totalBarWidth * 0.7);

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarWidth + (totalBarWidth - barWidth) / 2;
      const value = Math.min(1, bars[i]);
      const segments = Math.floor(value * this.maxSegments);

      for (let s = 0; s < segments; s++) {
        const ratio = s / this.maxSegments;
        const color = this.getColor(ratio, theme.segments);
        const y = canvas.height - (s + 1) * (this.segmentHeight + this.segmentGap);

        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth, this.segmentHeight);
      }
    }
  }

  getColor(ratio, colors) {
    const index = Math.min(colors.length - 1, Math.floor(ratio * colors.length));
    return colors[index];
  }
}
