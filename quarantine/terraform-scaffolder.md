# terraform-scaffolder

Generates Terraform module scaffolding with main.tf, variables.tf, outputs.tf.

## Requirements
- scaffold(module, resources[], variables[], outputs[]): returns file map
- resource(type, name, config{}): generates resource block
- variable(name, type, description, default?): generates variable block
- output(name, value, description?): generates output block
- renderModule(scaffold): returns { main, variables, outputs } as strings

## Status

Quarantine - pending review.

## Location

`packages/tools/terraform-scaffolder.ts`
