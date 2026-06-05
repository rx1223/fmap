import { useApolloClient, gql } from "@apollo/client";

const PURCHASE = gql`
  mutation Purchase($userId: ID!, $storeId: ID!) {
    purchaseTrialCard(userId: $userId, storeId: $storeId) {
      id
    }
  }
`;

export function CardPage() {
  const client = useApolloClient();

  const buy = () =>
    client.mutate({ mutation: PURCHASE, variables: { userId: "1", storeId: "1" } });

  // Inline gql passed via the client.mutate object form.
  const upgrade = () =>
    client.mutate({
      mutation: gql`
        mutation Upgrade($input: MembershipCardInput!) {
          updateMembershipCard(input: $input) {
            id
          }
        }
      `,
    });

  return (
    <div>
      <button onClick={buy}>Buy</button>
      <button onClick={upgrade}>Upgrade</button>
    </div>
  );
}
