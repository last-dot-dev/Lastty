use dashmap::DashMap;
use std::sync::Arc;

use super::app::App;
use super::ids::AppId;

#[derive(Default, Clone)]
pub struct AppRegistry {
    apps: Arc<DashMap<AppId, Arc<App>>>,
}

impl AppRegistry {
    pub fn insert(&self, app: Arc<App>) {
        self.apps.insert(app.id, app);
    }

    pub fn get(&self, id: AppId) -> Option<Arc<App>> {
        self.apps.get(&id).map(|r| r.clone())
    }

    pub fn remove(&self, id: AppId) {
        self.apps.remove(&id);
    }

    pub fn ids(&self) -> Vec<AppId> {
        self.apps.iter().map(|r| *r.key()).collect()
    }
}
