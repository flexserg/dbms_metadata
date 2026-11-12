ui = false
disable_mlock = true
api_addr = "http://openbao:8200"
cluster_addr = "https://openbao:8201"
storage "raft" {
  path = "/openbao/data"
  node_id = "openbao-0"
}
listener "tcp" {
  address = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable = true
}
