// Gemeinsame Hilfsfunktionen.

// Heutiges Datum als YYYY-MM-DD in lokaler Zeit (Europe/Luxembourg).
// Wichtig für "ab dem Termintag"-Prüfungen: sonst würde rund um Mitternacht
// die UTC-Zeit ein falsches Datum liefern (Luxemburg ist UTC+1/+2).
export function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Luxembourg' }).format(new Date());
}
