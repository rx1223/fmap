import { gql } from "@apollo/client";

// Several queries bundled in one document → one call-site, several resolvers.
export const TODAY_REVENUE = gql`
  query StoreRevenue($storeId: ID!) {
    todayRevenue(storeId: $storeId) {
      amount
      currency
    }
    revenueBreakdown(storeId: $storeId) {
      byCategory {
        amount
      }
    }
  }
`;

export const CREATE_USER = gql`
  mutation CreateUser($input: CreateUserInput!) {
    createUser(input: $input) {
      id
      name
    }
  }
`;

export const DELETE_USER = gql`
  mutation DeleteUser($id: ID!) {
    deleteUser(id: $id)
  }
`;
