import type { Point2D } from "./types";

const DEFAULT_GEOMETRY_EPSILON = 1e-10;

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function pointOnSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
  epsilon = DEFAULT_GEOMETRY_EPSILON,
): boolean {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const pointX = point.x - start.x;
  const pointY = point.y - start.y;
  const cross = pointX * segmentY - pointY * segmentX;
  const scale = Math.max(1, Math.abs(segmentX), Math.abs(segmentY));
  const squaredLength = segmentX * segmentX + segmentY * segmentY;

  // Closed polygon inputs commonly repeat their first vertex at the end.
  // Treat that zero-length edge as a point, not as a segment containing every
  // possible query point.
  if (squaredLength <= epsilon * epsilon) {
    return pointX * pointX + pointY * pointY <= epsilon * epsilon;
  }

  if (Math.abs(cross) > epsilon * scale) {
    return false;
  }

  const dot = pointX * segmentX + pointY * segmentY;
  return dot >= -epsilon && dot <= squaredLength + epsilon;
}

/**
 * Even-odd point-in-polygon test. Boundary points are included by default so
 * that symmetric rasterizations remain symmetric.
 */
export function pointInPolygon(
  point: Point2D,
  polygon: readonly Point2D[],
  includeBoundary = true,
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  let previous = polygon[polygon.length - 1];
  if (previous === undefined) {
    return false;
  }

  for (const current of polygon) {
    if (pointOnSegment(point, previous, current)) {
      return includeBoundary;
    }

    const crossesScanline = (current.y > point.y) !== (previous.y > point.y);
    if (crossesScanline) {
      const intersectionX =
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
        current.x;
      if (point.x < intersectionX) {
        inside = !inside;
      }
    }

    previous = current;
  }

  return inside;
}

export function regularPolygonVertices(
  sideCount: number,
  radius: number,
  rotationDeg = 0,
  center: Point2D = { x: 0, y: 0 },
): readonly Point2D[] {
  if (!Number.isInteger(sideCount) || sideCount < 3) {
    throw new RangeError("A regular polygon needs at least three sides.");
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError("A regular polygon radius must be positive.");
  }

  const rotation = degreesToRadians(rotationDeg);
  return Array.from({ length: sideCount }, (_, index) => {
    const angle = rotation + (index * 2 * Math.PI) / sideCount;
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });
}
