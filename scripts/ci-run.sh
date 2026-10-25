#!/usr/bin/env bash
# Запускает команду, не смешивая stdout и stderr (stdout можно разбирать как JSON).
# При ошибке дублирует хвост вывода в аннотацию GitHub, чтобы причина была видна
# прямо на странице запуска (и через API) без скачивания логов.
errf=$(mktemp)
out=$("$@" 2>"$errf"); code=$?
printf '%s\n' "$out"
cat "$errf" >&2
if [ $code -ne 0 ]; then
  msg=$(printf '%s\n%s' "$out" "$(cat "$errf")" | sed 's/\x1b\[[0-9;]*m//g; s/\r//g' \
    | grep -iE 'error|✘|failed|code: ' | tail -n 6 | sed 's/%/%25/g' | tr '\n' ' ')
  # Только строки с ошибкой: репозиторий публичный, а в остальном выводе wrangler есть имя аккаунта
  # stderr, чтобы аннотация не потерялась, если stdout перехвачен через $(...)
  echo "::error title=$*::$msg" >&2
fi
rm -f "$errf"
exit $code
