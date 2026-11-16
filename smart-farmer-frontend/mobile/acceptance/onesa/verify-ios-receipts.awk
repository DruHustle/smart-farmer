# Read only exact fixture summaries emitted during the current installed flow.
# Individual subject and membership checks run against the disposable Farmer DB.
NR <= from { next }
/^ONESA_DEVICE_PORTAL (login|continue|cancel) [1-5][0-9][0-9]$/ {
  sequence = sequence " " $2 "-" $3
  next
}
NF == 4 && $1 == "ONESA_DEVICE_HTTP" && $2 ~ /^(authorize|callback-page|session)$/ &&
  $3 ~ /^[1-5][0-9][0-9]$/ && $4 ~ /^[0-9]+$/ && length($4) == 13 {
  sequence = sequence " " $2 "-" $3
}
END {
  opening = " authorize-303"
  returning = " callback-page-200"
  session = " session-200"
  if (phase == "cancel" && role == "cancel")
    ok = sequence == opening " cancel-200" returning
  if (phase == "cold" && role == "member")
    ok = sequence == opening " login-200" returning session
  if (phase == "cold" && role == "admin")
    ok = sequence == opening " login-401 login-200" returning session
  if (phase == "active" && (role == "member" || role == "admin"))
    ok = sequence == opening returning session || sequence == opening " continue-200" returning session
  if (!ok) print "Expected issuer response and native exchange sequence was not observed for this attempt." > "/dev/stderr"
  exit !ok
}
