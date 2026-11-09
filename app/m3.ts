import { argbFromHex, hexFromArgb, Hct, MaterialDynamicColors, SchemeFidelity, SchemeTonalSpot } from '@material/material-color-utilities';

// Material 3 color roles exposed as --md-* CSS variables (see globals.css).
const accentRoles = ['primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'secondaryContainer', 'onSecondaryContainer', 'tertiaryContainer', 'onTertiaryContainer'] as const;
const neutralRoles = ['surface', 'surfaceDim', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'onSurface', 'onSurfaceVariant', 'outline', 'outlineVariant', 'inverseSurface', 'inverseOnSurface', 'error', 'onError', 'errorContainer', 'onErrorContainer'] as const;
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Generate a Google-style dynamic color scheme from one seed color (e.g. the wallpaper accent). */
export function applyMaterialTheme(seed: string, root: HTMLElement = document.documentElement, mobile = false) {
  if (mobile && seed.toLowerCase() === '#0b57d0') {
    for (const role of [...accentRoles, ...neutralRoles]) root.style.removeProperty(`--md-${kebab(role)}`);
    return;
  }
  const source = Hct.fromInt(argbFromHex(seed));
  // Fidelity keeps brand colors vivid for accents; tonal spot gives soft, lightly tinted surfaces.
  const neutral = new SchemeTonalSpot(source, false, 0);
  const accent = mobile ? neutral : new SchemeFidelity(source, false, 0);
  for (const role of accentRoles) root.style.setProperty(`--md-${kebab(role)}`, hexFromArgb(MaterialDynamicColors[role].getArgb(accent)));
  for (const role of neutralRoles) root.style.setProperty(`--md-${kebab(role)}`, hexFromArgb(MaterialDynamicColors[role].getArgb(neutral)));
  // Use the exact seed as the primary color when it is dark enough for white text (≥ 4.5:1).
  if ((1.05 / (luminance(seed) + 0.05)) >= 4.5) {
    root.style.setProperty('--md-primary', seed);
    root.style.setProperty('--md-on-primary', '#ffffff');
  }
}
