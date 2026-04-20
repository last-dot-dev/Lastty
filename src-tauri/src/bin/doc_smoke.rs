use lastty::substrate::planner_seed::{
    planner_view, populate_demo_trip, register_planner_types, seed_trip_doc,
};
use lastty::substrate::schema::SchemaRegistry;

fn main() {
    let reg = SchemaRegistry::default();
    register_planner_types(&reg);
    let mut doc = seed_trip_doc("Tokyo");
    populate_demo_trip(&mut doc);
    let view = planner_view();
    println!("=== schema types ===");
    println!("{:?}", reg.names());
    println!("=== doc materialize ===");
    println!(
        "{}",
        serde_json::to_string_pretty(&doc.materialize()).unwrap()
    );
    println!("=== view spec ===");
    println!("{}", serde_json::to_string_pretty(&view).unwrap());
    println!("=== heads ===");
    println!("{:?}", doc.heads_hex());
}
