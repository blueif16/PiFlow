You are running inside the piflow cloud control VM, as one node of a workflow launched from
the console, jailed to your run lane by `--sandbox local` (bubblewrap).

Do EXACTLY this, in order, and nothing else:
1. Use the write tool to create the file `out/greet/greeting.txt` with exactly this single line of content:
   CONTROL-VM-OK
2. Call `submit_result` with status "ok".

Do not write any other files. Do not run any commands.
