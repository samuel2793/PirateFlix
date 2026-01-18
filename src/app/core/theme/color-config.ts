/**
 * PirateFlix Color Theme Configuration
 * 
 * Sistema centralizado de colores para la aplicación.
 * Permite cambiar el color principal de marca sin modificar múltiples archivos.
 * 
 * INSTRUCCIONES DE USO:
 * 1. Para cambiar el color principal, modifica los valores en THEME.PRIMARY
 * 2. Los cambios se aplicarán globalmente en toda la aplicación
 * 3. El color se utiliza en: botones, navegación, badges, hovers, íconos interactivos, etc.
 * 4. El rojo se reserva exclusivamente para errores y estados negativos
 * 
 * EJEMPLO:
 * // Para cambiar a un azul vibrante:
 * PRIMARY: '#0066ff',
 * PRIMARY_DARK: '#0052cc',
 * PRIMARY_LIGHT: '#3385ff',
 */

export const THEME = {
  // Color primario de marca - Naranja (por defecto)
  // Usado en: botones, navegación activa, badges, hovers, etc.
  PRIMARY: '#e5a00d',
  PRIMARY_DARK: '#d08c00',
  PRIMARY_LIGHT: '#f5c518',

  // Color de error - Rojo
  // Usado SOLO para: mensajes de error, alertas, validaciones fallidas
  ERROR: '#ff6b6b',
  ERROR_DARK: '#ff5252',

  // Backgrounds
  BG_PRIMARY: '#0a0a0a',
  BG_SECONDARY: '#141414',
  BG_CARD: '#1a1a1a',
  BG_CARD_HOVER: '#252525',

  // Text
  TEXT_PRIMARY: '#ffffff',
  TEXT_SECONDARY: 'rgba(255, 255, 255, 0.7)',
  TEXT_MUTED: 'rgba(255, 255, 255, 0.5)',
};

/**
 * Función para aplicar el tema dinámicamente
 * Útil para cambios de tema en tiempo de ejecución
 */
export function applyTheme(overrides?: Partial<typeof THEME>) {
  const finalTheme = { ...THEME, ...overrides };

  // Aplicar variables CSS al documento
  const root = document.documentElement;
  root.style.setProperty('--color-primary', finalTheme.PRIMARY);
  root.style.setProperty('--color-primary-dark', finalTheme.PRIMARY_DARK);
  root.style.setProperty('--color-primary-light', finalTheme.PRIMARY_LIGHT);
  root.style.setProperty('--color-error', finalTheme.ERROR);
  root.style.setProperty('--color-error-dark', finalTheme.ERROR_DARK);
}

/**
 * Predicados para validar colores hexadecimales
 */
export const validateHexColor = (color: string): boolean => /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
