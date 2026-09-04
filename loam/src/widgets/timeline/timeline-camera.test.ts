import { describe, expect, it } from "vitest";
import { createTimelineCamera, formatTimelineTime, niceStep } from "./timeline-camera";

describe("niceStep", () => {
  it("picks the smallest step >= target", () => {
    expect(niceStep(0.05)).toBe(0.1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(9)).toBe(10);
  });

  it("falls back to the largest step when target exceeds every entry", () => {
    expect(niceStep(999999)).toBe(7200);
  });
});

describe("formatTimelineTime", () => {
  it("formats minutes:seconds.hundredths, zero-padded", () => {
    expect(formatTimelineTime(0)).toBe("0:00.00");
    expect(formatTimelineTime(65.5)).toBe("1:05.50");
    expect(formatTimelineTime(600)).toBe("10:00.00");
  });
});

describe("createTimelineCamera", () => {
  it("starts with a zero-duration view until setDuration() is called", () => {
    const cam = createTimelineCamera({ rowWidth: 100 });
    expect(cam.getView().duration).toBe(0);
    expect(cam.getView().pxPerSecond).toBe(0);
    expect(cam.screenXToTime(50)).toBe(0);
  });

  it("setDuration() zooms to fit and computes pxPerSecond", () => {
    const cam = createTimelineCamera({ rowWidth: 100 });
    cam.setDuration(10);
    expect(cam.getView().viewDuration).toBe(10);
    expect(cam.getView().pxPerSecond).toBe(10);
    expect(cam.timeToScreenX(5)).toBe(50);
    expect(cam.screenXToTime(50)).toBe(5);
  });

  it("setDuration() is a no-op (doesn't recenter) when the duration is unchanged", () => {
    const cam = createTimelineCamera({ rowWidth: 100 });
    cam.setDuration(10);
    cam.setZoom(1); // zoom in, moving off zoomIndex 0
    const before = cam.getView();
    cam.setDuration(10);
    expect(cam.getView()).toEqual(before);
  });

  it("zoomIn/zoomOut/zoomFit step through zoom levels and clamp at the ends", () => {
    const cam = createTimelineCamera({ rowWidth: 100, zoomLevels: [1, 2, 4] });
    cam.setDuration(100);
    expect(cam.getView().zoomIndex).toBe(0);
    cam.zoomOut(); // already at 0, clamps
    expect(cam.getView().zoomIndex).toBe(0);
    cam.zoomIn();
    expect(cam.getView().zoomIndex).toBe(1);
    expect(cam.getView().viewDuration).toBe(50);
    cam.zoomIn();
    cam.zoomIn(); // past the top, clamps at index 2
    expect(cam.getView().zoomIndex).toBe(2);
    cam.zoomFit();
    expect(cam.getView().zoomIndex).toBe(0);
  });

  it("panBy/panTo clamp the view window within [0, duration - viewDuration]", () => {
    const cam = createTimelineCamera({ rowWidth: 100, zoomLevels: [1, 4] });
    cam.setDuration(100);
    cam.zoomIn(); // viewDuration = 25
    cam.panTo(-50);
    expect(cam.getView().viewStartTime).toBe(0);
    cam.panTo(1000);
    expect(cam.getView().viewStartTime).toBe(75); // 100 - 25
    cam.panTo(40);
    expect(cam.getView().viewStartTime).toBe(40);
    cam.panBy(-1000);
    expect(cam.getView().viewStartTime).toBe(0);
  });

  it("setRowWidth() recomputes pxPerSecond without changing the view window", () => {
    const cam = createTimelineCamera({ rowWidth: 100 });
    cam.setDuration(10);
    cam.setRowWidth(200);
    expect(cam.getView().pxPerSecond).toBe(20);
    expect(cam.getView().viewDuration).toBe(10);
  });

  it("scrollTimeIntoView() recenters only once the playhead drifts past tolerance", () => {
    const cam = createTimelineCamera({ rowWidth: 100, zoomLevels: [1, 10] });
    cam.setDuration(100);
    cam.zoomIn(); // viewDuration = 10, centered on currentTime (0) -> viewStartTime 0
    const before = cam.getView().viewStartTime;
    cam.scrollTimeIntoView(4); // within default 0.15 tolerance of center (5)
    expect(cam.getView().viewStartTime).toBe(before);
    cam.scrollTimeIntoView(50); // way outside tolerance
    expect(cam.getView().viewStartTime).toBe(45); // centers 50 in a 10-wide window
  });

  it("scrollTimeIntoView() is a no-op when fully zoomed out to the whole duration", () => {
    const cam = createTimelineCamera({ rowWidth: 100 });
    cam.setDuration(100); // zoomFit by default, viewDuration === duration
    cam.scrollTimeIntoView(90);
    expect(cam.getView().viewStartTime).toBe(0);
  });

  it("onViewChange fires on zoom/pan/resize/duration mutations", () => {
    let calls = 0;
    const cam = createTimelineCamera({ rowWidth: 100, onViewChange: () => calls++ });
    cam.setDuration(10);
    cam.zoomIn();
    cam.panBy(1);
    cam.setRowWidth(50);
    expect(calls).toBe(4);
  });
});
