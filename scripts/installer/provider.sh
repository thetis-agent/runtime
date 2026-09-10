# Model configuration is validated before provisioning; API keys travel only over stdin.
provider_tool() {
  "$node_bin" --no-experimental-strip-types --import "file://$extracted/lib/artifacts/register.mjs" \
    "$extracted/lib/update/provider-setup.ts" "$@"
}

resolve_provider() {
  [ "$demo" = 0 ] || return 0
  if [ -n "$provider_config" ]; then
    cp "$provider_config" "$tmp/provider.json"
  else
    [ -n "$model" ] || die 'Choose --model <OpenRouter id>, --provider-config <file>, or --demo.'
    progress "Looking up $model"
    provider_tool openrouter "$model" "$daily_budget" "$tmp/provider.json" || die 'The selected model could not be configured.'
  fi
  provider_config="$tmp/provider.json"
  provider_tool check "$provider_config" || die 'The provider configuration is invalid.'
  if [ -n "$api_key_fd" ]; then
    eval "IFS= read -r api_key_value <&$api_key_fd" || [ -n "$api_key_value" ] || die 'The provider API key descriptor could not be read.'
  elif [ "$assume_yes" = 1 ]; then
    die 'A real provider needs --api-key-fd with --yes.'
  else
    stty -F /dev/tty -echo || die 'Cannot hide terminal input for the API key.'
    terminal_hidden=1
    printf 'Provider API key: ' > /dev/tty
    IFS= read -r api_key_value < /dev/tty || api_key_value=''
    printf '\n' > /dev/tty
    stty -F /dev/tty echo; terminal_hidden=0
  fi
  [ -n "$api_key_value" ] || die 'The provider API key must not be empty.'
  [ "$(printf '%s' "$api_key_value" | wc -c)" -le 16384 ] || die 'The provider API key is too long.'
}

seal_provider() {
  [ "$demo" = 0 ] || return 0
  if [ "$dry_run" = 1 ]; then say 'seal provider API key in the kernel secret store'; return 0; fi
  if [ "$key_store" = tpm2 ]; then
    systemd-creds decrypt --name=master "$credential_path" - | (
      exec 3<&0
      printf '%s' "$api_key_value" | provider_tool seal "$state" /dev/fd/3 "$operator_id"
    ) || die 'The provider API key could not be sealed with the TPM2 credential.'
  else
    printf '%s' "$api_key_value" | provider_tool seal "$state" "$credential_path" "$operator_id" \
      || die 'The provider API key could not be sealed.'
  fi
  api_key_value=''
}
