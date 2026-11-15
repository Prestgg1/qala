/**
 * Message catalogs for framework texts: validation issues and built-in errors. Keys are issue/error codes;
 * `{name}` placeholders are filled from the issue/error params. Register more locales with `registerLocale`.
 */
export type Catalog = Record<string, string>;

export const en: Catalog = {
  // validation issues
  required: "is required",
  type: "expected {expected}, got {actual}",
  min_length: "must be at least {min} characters",
  max_length: "must be at most {max} characters",
  pattern: "has an invalid format",
  format: "must be {format}",
  integer: "must be an integer",
  min: "must be at least {min}",
  max: "must be at most {max}",
  one_of: "must be one of: {values}",
  min_items: "must have at least {min} items",
  max_items: "must have at most {max} items",
  // errors
  validation_failed: "Invalid {where}",
  bad_request: "Bad request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_found: "Not found",
  resource_not_found: "{resource} not found",
  conflict: "Conflict",
  too_many_requests: "Too many requests",
  method_not_allowed: "Method {method} not allowed",
  route_not_found: "No route for {method} {path}",
  invalid_json: "The body is not valid JSON",
  unique_violation: "{field} already exists",
  unique_violation_generic: "Already exists",
  foreign_key_violation: "{field} refers to a missing record",
  foreign_key_violation_generic: "Refers to a missing record",
  not_null_violation: "{field} is required",
  invalid_input: "Invalid value",
  internal_error: "Internal server error",
};

export const az: Catalog = {
  required: "Bu sahəni doldurun",
  type: "Dəyər düzgün deyil",
  min_length: "Ən azı {min} simvol olmalıdır",
  max_length: "Ən çox {max} simvol ola bilər",
  pattern: "Format düzgün deyil",
  format: "Format düzgün deyil",
  integer: "Tam rəqəm yazın",
  min: "Ən azı {min} olmalıdır",
  max: "Ən çox {max} ola bilər",
  one_of: "Siyahıdan birini seçin",
  min_items: "Ən azı {min} element seçin",
  max_items: "Ən çox {max} element seçin",
  validation_failed: "Yanlış sorğu məlumatı",
  bad_request: "Yanlış sorğu",
  unauthorized: "Giriş tələb olunur",
  forbidden: "Bu əməliyyat üçün icazəniz yoxdur",
  not_found: "Məlumat tapılmadı",
  resource_not_found: "{resource} tapılmadı",
  conflict: "Bu məlumat artıq mövcuddur",
  too_many_requests: "Çox sayda sorğu, bir az sonra yenidən cəhd edin",
  method_not_allowed: "{method} metodu bu ünvan üçün icazəli deyil",
  route_not_found: "Belə bir ünvan yoxdur",
  invalid_json: "Sorğunun gövdəsi düzgün JSON deyil",
  unique_violation: "{field} artıq mövcuddur",
  unique_violation_generic: "Bu məlumat artıq mövcuddur",
  foreign_key_violation: "{field} mövcud olmayan qeydə istinad edir",
  foreign_key_violation_generic: "Mövcud olmayan qeydə istinad edir",
  not_null_violation: "{field} doldurulmalıdır",
  invalid_input: "Dəyər düzgün deyil",
  internal_error: "Daxili server xətası baş verdi",
};

const catalogs = new Map<string, Catalog>([
  ["en", en],
  ["az", az],
]);

/** Adds or replaces a locale (missing keys fall back to English). */
export function registerLocale(code: string, catalog: Catalog): void {
  catalogs.set(code.toLowerCase(), catalog);
}

export function hasLocale(code: string): boolean {
  return catalogs.has(code.toLowerCase());
}

/** The message for `code` in `locale` (falling back to English, then to `fallback`), with `{params}` filled in. */
export function translate(code: string, params: Record<string, string>, locale: string, fallback: string): string {
  const template = catalogs.get(locale)?.[code] ?? en[code];
  if (template === undefined) return fallback;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => params[name] ?? whole);
}

/**
 * The locale for a request: the first `Accept-Language` tag (or its primary subtag) that has a catalog,
 * otherwise `fallback`.
 */
export function pickLocale(acceptLanguage: string | undefined, fallback: string): string {
  if (acceptLanguage === undefined || acceptLanguage === "") return fallback;
  for (const part of acceptLanguage.split(",")) {
    const tag = (part.split(";")[0] ?? "").trim().toLowerCase();
    if (tag === "" || tag === "*") continue;
    if (catalogs.has(tag)) return tag;
    const primary = tag.split("-")[0] ?? "";
    if (catalogs.has(primary)) return primary;
  }
  return fallback;
}
