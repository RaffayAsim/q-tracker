import { useEffect, useRef, useState } from "react";

interface ActivityDetectorOptions {
  employeeId: string;
  isClockedIn: boolean;
  isOnBreak: boolean;
  onAwayDetected: (durationSeconds: number, startTime: string, endTime: string) => void;
  thresholdMs?: number; // Defaults to 15 minutes (15 * 60 * 1000)
}

export function useActivityDetector({
  employeeId,
  isClockedIn,
  isOnBreak,
  onAwayDetected,
  thresholdMs = 15 * 60 * 1000,
}: ActivityDetectorOptions) {
  const [isIdle, setIsIdle] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awayStartRef = useRef<Date | null>(null);

  // We use refs to avoid resetting event listeners when state or callbacks change
  const stateRef = useRef({
    isClockedIn,
    isOnBreak,
    employeeId,
    onAwayDetected,
    isIdle,
  });

  useEffect(() => {
    stateRef.current = {
      isClockedIn,
      isOnBreak,
      employeeId,
      onAwayDetected,
      isIdle,
    };
  }, [isClockedIn, isOnBreak, employeeId, onAwayDetected, isIdle]);

  useEffect(() => {
    // If not clocked in or already on an explicit manual break, disable the idle detector
    if (!isClockedIn || isOnBreak) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (isIdle) {
        setIsIdle(false);
        awayStartRef.current = null;
      }
      return;
    }

    const resetTimer = () => {
      // If we were previously marked as idle/away
      if (awayStartRef.current && stateRef.current.isIdle) {
        const endTime = new Date();
        const startTime = awayStartRef.current;
        const diffMs = endTime.getTime() - startTime.getTime();
        const durationSeconds = Math.max(0, Math.floor(diffMs / 1000));

        // Trigger return callback if duration is valid
        if (durationSeconds > 0) {
          stateRef.current.onAwayDetected(
            durationSeconds,
            startTime.toISOString(),
            endTime.toISOString()
          );
        }

        // Reset away tracker
        setIsIdle(false);
        awayStartRef.current = null;
      }

      // Clear existing idle timer
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

      // Start a new idle timer
      idleTimerRef.current = setTimeout(() => {
        // Double-check clocked in and not on break before setting idle
        if (stateRef.current.isClockedIn && !stateRef.current.isOnBreak) {
          setIsIdle(true);
          awayStartRef.current = new Date();
        }
      }, thresholdMs);
    };

    // Global events that prove user activity
    const activityEvents = [
      "mousemove",
      "keydown",
      "mousedown",
      "scroll",
      "click",
      "touchstart",
    ];

    // Initialize/start the first timer
    resetTimer();

    // Bind event listeners
    const handleActivity = () => {
      resetTimer();
    };

    activityEvents.forEach((event) => {
      window.addEventListener(event, handleActivity, { passive: true });
    });

    // Cleanup on unmount or when dependencies change
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      activityEvents.forEach((event) => {
        window.removeEventListener(event, handleActivity);
      });
    };
  }, [isClockedIn, isOnBreak, thresholdMs]);

  return { isIdle };
}
