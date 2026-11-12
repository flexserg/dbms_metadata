path "secret/config" {
  capabilities = ["read"]
}
path "secret/data/connections/*" {
  capabilities = ["create", "read", "update"]
}
path "secret/metadata/connections/*" {
  capabilities = ["delete"]
}
