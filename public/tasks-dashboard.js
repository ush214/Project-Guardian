<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Task Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .cycle-btn { cursor:pointer; }
    .status-pill {
      @apply inline-block px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase;
    }
  </style>
</head>
<body class="bg-slate-50 text-gray-900 min-h-screen flex flex-col">
  <header class="bg-white border-b shadow-sm">
    <div class="max-w-4xl mx-auto px-5 py-4 flex flex-wrap gap-4 items-center">
      <h1 class="text-2xl font-semibold text-slate-800">Task Dashboard</h1>
      <div class="ml-auto flex flex-col items-end text-xs text-slate-600">
        <div><span class="font-medium">User:</span> <span id="hdr-email" class="text-slate-800">—</span></div>
        <div><span class="font-medium">Role:</span> <span id="hdr-role" class="text-slate-800">—</span></div>
      </div>
      <button id="btn-signout"
              class="text-xs px-3 py-1 rounded border border-slate-300 bg-white hover:bg-slate-100 text-slate-700">
        Sign out
      </button>
      <a href="index.html"
         class="text-xs px-3 py-1 rounded border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700">
        ← Back to App
      </a>
    </div>
  </header>

  <main class="flex-1 max-w-4xl mx-auto w-full px-5 py-6 space-y-8">
    <!-- Admin Create Form -->
    <section id="create-section"
             class="bg-white border rounded-xl shadow-sm p-5 space-y-4 hidden">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-semibold text-slate-800">Create Task</h2>
        <span class="text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-300">ADMIN</span>
      </div>
      <form id="task-form" class="grid md:grid-cols-3 gap-4 items-start">
        <div class="md:col-span-1">
          <label class="text-xs font-semibold text-slate-600 block mb-1">Title</label>
          <input id="task-title" type="text" required
                 class="w-full px-3 py-2 rounded border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                 placeholder="Short summary">
        </div>
        <div class="md:col-span-1">
          <label class="text-xs font-semibold text-slate-600 block mb-1">Status</label>
          <select id="task-status"
                  class="w-full px-3 py-2 rounded border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="pending">pending</option>
            <option value="in_progress">in_progress</option>
            <option value="done">done</option>
          </select>
        </div>
        <div class="md:col-span-1">
          <label class="text-xs font-semibold text-slate-600 block mb-1">Optional Tags (comma‑sep)</label>
          <input id="task-tags" type="text"
                 class="w-full px-3 py-2 rounded border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                 placeholder="ops,urgent">
        </div>
        <div class="md:col-span-3">
          <label class="text-xs font-semibold text-slate-600 block mb-1">Description</label>
          <textarea id="task-desc" rows="3"
                    class="w-full px-3 py-2 rounded border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Details of the task or next steps..."></textarea>
        </div>
        <div class="md:col-span-3 flex items-center justify-end gap-3">
          <span id="create-msg" class="text-xs text-slate-500 h-4"></span>
          <button type="submit"
                  class="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium shadow">
            Create Task
          </button>
        </div>
      </form>
    </section>

    <!-- Task List -->
    <section class="bg-white border rounded-xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-slate-800">Tasks</h2>
        <div id="tasks-status" class="text-xs text-slate-600">Initializing…</div>
      </div>
      <ul id="tasks-list" class="space-y-3"></ul>
      <div id="empty-indicator" class="hidden text-sm text-slate-500 py-4 text-center">
        No tasks found.
      </div>
    </section>

    <p class="text-[11px] text-slate-500">
      Path: <code>artifacts/guardian/private/admin/tasks</code>.
      Only admins (custom claim or allowlist) have read/write permission per Firestore rules.
    </p>
  </main>

  <script type="module" src="./auth-role.js"></script>
  <script type="module" src="./tasks-dashboard.js"></script>
</body>
</html>