(() => {
  const $ = (id) => document.getElementById(id);

  async function solve(program) {
    const stdout = [];
    const stderr = [];
    const module = await createClingconDemo({
      noInitialRun: true,
      print: (line) => stdout.push(String(line)),
      printErr: (line) => stderr.push(String(line)),
    });

    const exitCode = module.ccall(
      'clingcon_run',
      'number',
      ['string', 'string'],
      [program, '--models=1']
    );
    return {
      exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  }

  $('run').addEventListener('click', async () => {
    $('run').disabled = true;
    $('status').textContent = '実行中…';
    $('stdout').textContent = '';
    $('stderr').textContent = '';
    try {
      const result = await solve($('program').value);
      $('stdout').textContent = result.stdout;
      $('stderr').textContent = result.stderr;
      if (![10, 20, 30].includes(result.exitCode)) {
        $('status').textContent = `ERROR (${result.exitCode})`;
      }
      else {
        $('status').textContent = /^SATISFIABLE$/m.test(result.stdout) ? 'SATISFIABLE' : (/^UNSATISFIABLE$/m.test(result.stdout) ? 'UNSATISFIABLE' : '完了');
      }
    }
    catch (error) {
      $('status').textContent = 'ERROR';
      $('stderr').textContent = error && error.stack ? error.stack : String(error);
    }
    finally {
      $('run').disabled = false;
    }
  });
})();
