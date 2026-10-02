export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface Size2D {
  readonly width: number;
  readonly height: number;
}

export function toRenderCoordinates(
  point: Point2D,
  cssSize: Size2D,
  renderSize: Size2D,
): Point2D {
  if (
    cssSize.width <= 0 ||
    cssSize.height <= 0 ||
    renderSize.width <= 0 ||
    renderSize.height <= 0
  ) {
    throw new RangeError("Canvas dimensions must be greater than zero.");
  }

  return {
    x: (point.x / cssSize.width) * renderSize.width,
    y: (point.y / cssSize.height) * renderSize.height,
  };
}
