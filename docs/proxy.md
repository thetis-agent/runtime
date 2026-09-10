# Browser proxy configuration

Thetis serves login and each person's browser gateway over separate Unix sockets.
`sudo /opt/thetis/bin/thetis status` prints their stable paths. A TLS endpoint on
the same host can route directly to these sockets. If TLS terminates on another
machine, also run a host-side HTTP proxy next to Thetis and point the TLS endpoint
at its private address and port. A remote proxy cannot open this host's Unix sockets.

The host proxy is trusted operator infrastructure, not a runtime package. It
needs filesystem access to the selected public sockets. Do not make the state
tree world-readable to obtain that access, and never forward the CLI or supervisor
control socket to the network. Keep the trusted kernel origin on a different
hostname from the login and chat pages.

## Example: Nginx behind an existing TLS endpoint

Adapt the following to your host. Replace `PRIVATE_BIND_IP`, `TLS_PROXY_IP`,
`LOGIN_SOCKET`, `ADMIN_WEB_SOCKET` and `agent.example.org`; use your administrator
id in place of `admin`. The two socket values come from `thetis status` and retain
the `live` component. Do not substitute a generation-specific `g/...` path.
Place this fragment inside Nginx's `http` context, such as a site include.

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
upstream thetis_login { server unix:LOGIN_SOCKET; }
upstream thetis_chat { server unix:ADMIN_WEB_SOCKET; }
server {
    listen PRIVATE_BIND_IP:8777;
    server_name agent.example.org;
    allow TLS_PROXY_IP;
    deny all;
    absolute_redirect off;
    client_max_body_size 1m;
    proxy_http_version 1.1;
    proxy_read_timeout 600s;
    proxy_buffering off;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Prefix "";
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    location = / { return 302 /admin/; }
    location = /admin { return 308 /admin/; }
    location /login {
        proxy_pass http://thetis_login;
    }
    location /admin/ {
        # Nginx replaces inherited proxy_set_header directives when any are
        # specified here, so repeat the full header set for this route.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-Prefix /admin;
        proxy_pass http://thetis_chat/;
    }
    location / { return 404; }
}
```

Login keeps its `/login` path. The account route strips `/admin` and sets
`X-Forwarded-Prefix: /admin`, so redirects and relative assets stay under the
account's prefix. WebSocket upgrade headers are required; see the official
[Nginx WebSocket guide](https://nginx.org/en/docs/http/websocket.html).

The external TLS proxy should preserve the public `Host` header and forward
WebSocket upgrades. For example, an existing Caddy site can use
`reverse_proxy PRIVATE_BIND_IP:8777`. Apply changes only to the intended site.
Validate the proxy configuration before reloading its service.

Verify the real HTTPS URL: sign in, load the account page, send a message and
check that a completed answer arrives. Repeat after restarting Thetis. Kernel
sessions expire across generation changes, so signing in again can be required;
conversation history must remain available.
