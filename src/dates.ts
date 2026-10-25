const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const SHORT_WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Сегодняшняя дата в часовом поясе tz: "YYYY-MM-DD" и день недели 1..7. */
export function localToday(now: Date, tz: string): { date: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: SHORT_WEEKDAYS[parts.weekday] };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Ближайший игровой день, начиная с сегодняшнего (в четверг — сегодня). */
export function nextGameDate(now: Date, tz: string, gameWeekday: number): string {
  const today = localToday(now, tz);
  return addDays(today.date, (gameWeekday - today.weekday + 7) % 7);
}

/** "2026-10-29" → "четверг, 29 октября" */
export function formatGameDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[weekday]}, ${d} ${MONTHS[m - 1]}`;
}
