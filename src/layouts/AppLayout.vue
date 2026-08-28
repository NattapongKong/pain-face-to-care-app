<script setup>
</script>

<template>
  <div class="min-h-screen bg-base-300">
    <header class="bg-primary-700 text-white shadow-md">
      <div class="mx-auto flex w-full max-w-md items-center p-4">
        <router-link to="/" class="text-lg font-semibold text-white">
          PAIN FACE to Care
        </router-link>
      </div>
    </header>
    <main class="mx-auto w-full max-w-md p-4 pb-24">
      <slot />
    </main>
  </div>
</template>
