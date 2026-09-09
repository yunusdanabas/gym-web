export function clockParts(hours, minutes) {
  if (hours === undefined && minutes === undefined) return undefined;
  const parts = {hours: hours ?? 0, minutes: minutes ?? 0};
  if (!Number.isFinite(parts.hours) || parts.hours < 0) {
    throw new Error("Hours must be 0 or more.");
  }
  if (!Number.isFinite(parts.minutes) || parts.minutes < 0 || parts.minutes > 59) {
    throw new Error("Minutes must be between 0 and 59.");
  }
  return parts;
}

export function clockToHours(parts, limitHours) {
  if (!parts) return undefined;
  const hours = parts.hours + parts.minutes / 60;
  if (hours > limitHours) throw new Error(`Sleep cannot exceed ${limitHours} hours.`);
  return hours;
}

export function clockToMinutes(parts) {
  if (!parts) return undefined;
  return parts.hours * 60 + parts.minutes;
}

export function hoursToClock(hoursValue) {
  if (hoursValue === undefined || hoursValue === null) return undefined;
  const total = Math.round(Number(hoursValue) * 60);
  return {hours: Math.floor(total / 60), minutes: total % 60};
}

export function minutesToClock(minutesValue) {
  if (minutesValue === undefined || minutesValue === null) return undefined;
  const total = Number(minutesValue);
  return {hours: Math.floor(total / 60), minutes: total % 60};
}
