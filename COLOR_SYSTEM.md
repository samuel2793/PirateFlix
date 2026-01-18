# Sistema de Colores de PirateFlix

## Overview

PirateFlix implementa un sistema de colores centralizado y consistente que:

- ✅ Utiliza **naranja** como color principal de marca en toda la aplicación
- ✅ Mantiene **rojo** exclusivamente para errores y estados negativos
- ✅ Proporciona coherencia visual en todas las pantallas
- ✅ Permite cambios globales de color sin modificar múltiples archivos
- ✅ Facilita la extensión a temas dinámicos en el futuro

## Estructura de Colores

### Color Principal (Naranja)
```scss
$accent-primary: #e5a00d;        // Naranja estándar
$accent-primary-dark: #d08c00;   // Para hovers y estados oscuros
$accent-primary-light: #f5c518;  // Para acentos y variaciones claras
```

**Aplicado a:**
- Botones primarios (Play, Add to List, etc.)
- Navegación activa
- Badges y etiquetas
- Estados hover/active
- Íconos interactivos
- Líneas activas/indicadores
- Enlaces destacados

### Color de Error (Rojo)
```scss
$accent-error: #ff6b6b;          // Rojo para errores
$accent-error-dark: #ff5252;     // Rojo oscuro para hovers
```

**Aplicado a:**
- Mensajes de error
- Alertas y validaciones fallidas
- Estados de error cargando
- Botones destructivos

### Backgrounds y Texto
```scss
$bg-primary: #0a0a0a;            // Negro principal
$bg-secondary: #141414;          // Gris oscuro para navbar
$bg-card: #1a1a1a;               // Gris oscuro para cards
$bg-card-hover: #252525;         // Hover state para cards

$text-primary: #ffffff;          // Blanco principal
$text-secondary: rgba(255, 255, 255, 0.7);  // Gris claro
$text-muted: rgba(255, 255, 255, 0.5);      // Gris más oscuro
```

## Cómo Cambiar el Color Principal

### Opción 1: Cambio Global Permanente (Recomendado)

Edita `src/styles.scss`:

```scss
// BRAND COLOR (Color principal - Naranja) - Cambia esto para cambiar el color de marca global
$accent-primary: #e5a00d;        // Cambiar a tu color deseado
$accent-primary-dark: #d08c00;   // Versión oscura
$accent-primary-light: #f5c518;  // Versión clara
```

Todos los archivos SCSS heredarán automáticamente estos valores.

### Opción 2: Cambio Dinámico en Tiempo de Ejecución

Usa la función `applyTheme()` de `src/app/core/theme/color-config.ts`:

```typescript
import { applyTheme } from './core/theme/color-config';

// Cambiar a azul
applyTheme({
  PRIMARY: '#0066ff',
  PRIMARY_DARK: '#0052cc',
  PRIMARY_LIGHT: '#3385ff',
});
```

## Coherencia Visual Entre Pantallas

### Home / Browse
- Logo: Naranja
- Botones principales: Naranja
- Navegación activa: Naranja
- Hovers de cards: Naranja

### Details Page
- Badges de media: Naranja (cambió de rojo)
- Botones de acción: Naranja
- Toggles activados: Naranja
- Información interactiva: Naranja

### Player
- Controles: Mantiene coherencia con el sistema

### Person Page
- Badges de información: Naranja
- Elementos interactivos: Naranja

## Archivos Modificados

```
src/
├── styles.scss                          # Variables globales de color
├── app/
│   ├── core/theme/
│   │   └── color-config.ts             # Configuración de tema (nuevo)
│   ├── features/
│   │   ├── home/home.scss              # Usa $accent-primary
│   │   ├── details/details.scss        # Usa $accent-primary
│   │   ├── player/player.scss          # Coherente con sistema
│   │   └── person/person.scss          # Coherente con sistema
```

## Guía de Colores para Nuevas Funcionalidades

Al añadir nuevos componentes, sigue estas reglas:

```scss
// ✅ CORRECTO - Usar naranja para interacción
.my-button {
  background: $accent-primary;
  
  &:hover {
    background: $accent-primary-dark;
  }
}

// ✅ CORRECTO - Usar rojo solo para errores
.error-message {
  color: $accent-error;
}

// ❌ INCORRECTO - No hardcodear rojo para elementos normales
.my-badge {
  color: #e50914; // ← Evitar, usar variable
}

// ❌ INCORRECTO - No crear nuevas variables de color
$my-custom-orange: #ff9900; // ← Usar $accent-primary en su lugar
```

## Ejemplos de Aplicación

### Botón primario
```scss
.btn-primary {
  background: $accent-primary;
  color: #000;
  
  &:hover {
    background: $accent-primary-dark;
  }
}
```

### Badge informativo
```scss
.badge-info {
  background: rgba($accent-primary, 0.2);
  color: $accent-primary;
  border: 1px solid $accent-primary;
}
```

### Indicador activo
```scss
.nav-item.active {
  color: $accent-primary;
  border-bottom: 3px solid $accent-primary;
}
```

### Mensaje de error
```scss
.alert-error {
  background: rgba($accent-error, 0.15);
  color: $accent-error;
  border-left: 4px solid $accent-error;
}
```

## Temas Futuros

El sistema está preparado para soportar:

- 🎨 Cambio de tema en tiempo de ejecución
- 🌙 Modo claro/oscuro
- 🎭 Múltiples variaciones de marca
- 📱 Sincronización entre dispositivos

Para implementar, expande la función `applyTheme()` con CSS variables dinámicas.

## Preguntas Frecuentes

**P: ¿Puedo cambiar solo el color principal sin afectar el rojo?**
R: Sí, el rojo está separado en `$accent-error` y `$accent-error-dark`. Cambia `$accent-primary` en `styles.scss`.

**P: ¿Qué pasa si olvido actualizar una referencia?**
R: Las variables se heredan automáticamente. Si encuentras un color hardcodeado, actualízalo a la variable correspondiente.

**P: ¿Cómo agrego un nuevo color al sistema?**
R: Define la variable en `src/styles.scss` y documenta su uso en este archivo.

**P: ¿Puedo tener diferentes colores en diferentes secciones?**
R: Se recomienda mantener coherencia. Si es necesario, crea variables específicas de sección pero siempre heredadas del color primario.
