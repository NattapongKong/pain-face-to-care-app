<script setup>
import { computed } from 'vue'
import {
  X, Check, Search, Plus, Minus, Trash2, Pencil, Eye, EyeOff,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Camera, CameraOff, Video, VideoOff, RefreshCw, RotateCcw,
  Info, Clock, Home, List, ClipboardList, ClipboardCheck, Settings, Bell,
  Copy, Share2, Upload, Download, QrCode, Save, Calendar,
  AlertTriangle, AlertCircle, CheckCircle2, Loader2,
  Smile, Frown, Meh, Sparkles, ScanFace, Stethoscope, Thermometer,
  Activity, HeartPulse, Timer, FileText, User, Users, MapPin,
} from 'lucide-vue-next'

// One entry per stable name used across the app. Unknown names fall back to a
// visible glyph (never a blank/empty render) with a dev-only console warning.
const MAP = {
  close: X, check: Check, search: Search, plus: Plus, minus: Minus,
  trash: Trash2, edit: Pencil, eye: Eye, 'eye-off': EyeOff,
  'chevron-down': ChevronDown, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, 'chevron-up': ChevronUp,
  camera: Camera, 'camera-off': CameraOff, video: Video, 'video-off': VideoOff,
  refresh: RefreshCw, 'rotate-ccw': RotateCcw,
  info: Info, clock: Clock, timer: Timer, home: Home, list: List,
  clipboard: ClipboardList, 'clipboard-check': ClipboardCheck,
  settings: Settings, bell: Bell, copy: Copy, share: Share2,
  upload: Upload, download: Download, qrcode: QrCode, save: Save,
  calendar: Calendar,
  warning: AlertTriangle, 'alert-triangle': AlertTriangle,
  error: AlertCircle, 'alert-circle': AlertCircle, success: CheckCircle2,
  loader: Loader2,
  smile: Smile, frown: Frown, meh: Meh, sparkles: Sparkles, 'scan-face': ScanFace,
  stethoscope: Stethoscope, thermometer: Thermometer, activity: Activity,
  'heart-pulse': HeartPulse, file: FileText, user: User, users: Users, pin: MapPin,
}

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [String, Number], default: 20 },
  label: { type: String, default: '' }, // a11y: pass to make the icon meaningful
})

const Cmp = computed(() => {
  const c = MAP[props.name]
  if (!c && import.meta.env.DEV) console.warn(`[Icon] unknown name "${props.name}"`)
  return c || AlertCircle
})
</script>

<template>
  <component
    :is="Cmp"
    :size="size"
    class="shrink-0"
    focusable="false"
    :aria-hidden="label ? undefined : true"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
  />
</template>
