// Module-level (singleton) toast queue so any caller of useToast() and the
// single mounted <ToastContainer/> share the same list, matching the Vue
// "global composable state" pattern (no store/provide needed for a leaf UI
// concern like this).
import { ref } from 'vue'

const toasts = ref([])
let nextId = 0

const DURATION_MS = 3000

export function useToast() {
  /**
   * Show a toast.
   * @param {string} message
   * @param {'success'|'info'|'warning'|'error'} [type]
   * @returns {number} toast id
   */
  function toast(message, type = 'info') {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => dismiss(id), DURATION_MS)
    return id
  }

  function dismiss(id) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { toast, dismiss, toasts }
}
