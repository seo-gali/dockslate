use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub(crate) struct DockerSnapshot {
    pub engine_status: Result<Value, String>,
    pub overview: Result<Value, String>,
    pub containers_list: Result<Value, String>,
    pub images_list: Result<Value, String>,
    pub disk_usage: Result<Value, String>,
    pub volumes_list: Result<Value, String>,
    pub networks_list: Result<Value, String>,
}

#[derive(Serialize)]
pub(crate) struct NetworkCreated<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub internal: bool,
}
